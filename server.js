require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuid } = require('uuid');
const cron = require('node-cron');

const db = require('./db');
const { classify } = require('./lib/classifier');
const { runRecovery, markRecovered, audit } = require('./lib/recoveryEngine');
const { isValidSignature } = require('./lib/verifyWebhook');

const app = express();
const PORT = process.env.PORT || 3000;

// Keep the raw body around for webhook signature verification.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------
// Helpers to pull normalized fields out of a Razorpay-shaped payload.
// ---------------------------------------------------------------------
function extractPaymentFields(payload) {
  const p = payload?.payload?.payment?.entity || {};
  return {
    entityId: p.order_id || p.id,
    paymentId: p.id,
    amountPaise: p.amount,
    currency: p.currency || 'INR',
    email: p.email,
    phone: p.contact,
    errorCode: p.error_code,
    errorDescription: p.error_description,
    errorReason: p.error_reason,
    errorSource: p.error_source,
  };
}

function extractSubscriptionFields(payload) {
  const s = payload?.payload?.subscription?.entity || {};
  return {
    entityId: s.id,
    amountPaise: s.plan_id ? undefined : undefined, // subscription entity may not carry amount directly
    customerId: s.customer_id,
  };
}

// ---------------------------------------------------------------------
// POST /webhook/razorpay  — the real integration point
// ---------------------------------------------------------------------
app.post('/webhook/razorpay', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (secret && !isValidSignature(req.rawBody, signature, secret)) {
    return res.status(400).json({ error: 'invalid signature' });
  }

  const payload = req.body;
  const eventType = payload.event;
  const razorpayEventId = payload.account_id ? `${payload.account_id}:${eventType}:${Date.now()}` : `${eventType}:${Date.now()}`;

  try {
    await handleEvent(eventType, payload, razorpayEventId);
    res.status(200).json({ ok: true }); // Razorpay requires a 2xx or it will retry/disable the webhook
  } catch (err) {
    console.error('webhook handling error', err);
    // Still 200 so Razorpay doesn't hammer retries for a bug on our side during a demo;
    // in production you'd want more nuance here.
    res.status(200).json({ ok: false, error: err.message });
  }
});

async function handleEvent(eventType, payload, razorpayEventId) {
  let fields, amountPaise, name, email, phone, lang;

  if (eventType === 'payment.failed') {
    fields = extractPaymentFields(payload);
    amountPaise = fields.amountPaise;
    email = fields.email;
    phone = fields.phone;
  } else if (eventType === 'subscription.pending' || eventType === 'subscription.halted') {
    const s = extractSubscriptionFields(payload);
    fields = { entityId: s.entityId, eventType };
    amountPaise = payload.payload?.subscription?.entity?.notes?.amount_paise || 50000; // fallback for demo
    phone = payload.payload?.subscription?.entity?.notes?.phone;
    email = payload.payload?.subscription?.entity?.notes?.email;
  } else if (eventType === 'checkout.abandoned') {
    // Synthetic event type we generate ourselves (see checkAbandonedCheckouts below)
    const o = payload.payload.order.entity;
    fields = { entityId: o.id, eventType };
    amountPaise = o.amount;
    email = o.notes?.email;
    phone = o.notes?.phone;
  } else if (eventType === 'invoice.overdue') {
    const inv = payload.payload.invoice.entity;
    fields = { entityId: inv.id, eventType };
    amountPaise = inv.amount;
    email = inv.customer_details?.email;
    phone = inv.customer_details?.contact;
  } else {
    // payment.authorized / order.paid / payment.captured -> treat as recovery signal
    if (['payment.captured', 'order.paid'].includes(eventType)) {
      const p = payload.payload?.payment?.entity || payload.payload?.order?.entity || {};
      const entityId = p.order_id || p.id;
      const count = markRecovered(entityId, p.amount);
      audit(null, entityId, 'system', 'CAPTURED_SIGNAL_RECEIVED', { eventType, resolvedEvents: count });
    }
    return; // nothing to classify/act on for other event types
  }

  name = payload.payload?.payment?.entity?.notes?.customer_name || 'there';
  lang = payload.payload?.payment?.entity?.notes?.lang || phoneLikelyHinglish(phone);

  const { rootCause, reason, playbook } = classify({
    eventType,
    errorCode: fields.errorCode,
    errorReason: fields.errorReason,
    errorDescription: fields.errorDescription,
    errorSource: fields.errorSource,
  });

  const eventId = uuid();
  db.prepare(
    `INSERT INTO events
      (id, razorpay_event_id, event_type, entity_type, entity_id, amount_paise, currency, customer_email, customer_phone, customer_lang, raw_payload, root_cause, recommended_action)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    eventId,
    razorpayEventId,
    eventType,
    'payment',
    fields.entityId,
    amountPaise || 0,
    'INR',
    email || null,
    phone || null,
    lang,
    JSON.stringify(payload),
    rootCause,
    playbook.action
  );

  audit(eventId, fields.entityId, 'classifier', 'CLASSIFIED', { rootCause, reason });

  await runRecovery({
    eventId,
    entityId: fields.entityId,
    rootCause,
    playbook,
    amountPaise: amountPaise || 0,
    name,
    email,
    phone: phone || '+910000000000',
    lang,
  });
}

function phoneLikelyHinglish() {
  // Placeholder heuristic — in a real build, key this off customer locale/geo.
  return 'hi';
}

// ---------------------------------------------------------------------
// Checkout abandonment detector — polls `orders` state and synthesizes
// a `checkout.abandoned` event if an order sits unpaid past the threshold.
// For the hackathon demo, the simulator posts directly to this endpoint
// instead of us polling the live Orders API.
// ---------------------------------------------------------------------
app.post('/internal/mark-abandoned', async (req, res) => {
  const { orderId, amountPaise, email, phone, name } = req.body;
  const syntheticPayload = {
    event: 'checkout.abandoned',
    payload: { order: { entity: { id: orderId, amount: amountPaise, notes: { email, phone, customer_name: name } } } },
  };
  await handleEvent('checkout.abandoned', syntheticPayload, `synthetic:${orderId}`);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Promise-to-pay tracker
// ---------------------------------------------------------------------
app.post('/api/promise-to-pay', (req, res) => {
  const { entityId, customerName, customerPhone, amountPaise, promisedDate } = req.body;
  const id = uuid();
  db.prepare(
    `INSERT INTO promises_to_pay (id, entity_id, customer_name, customer_phone, amount_paise, promised_date) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, entityId, customerName, customerPhone, amountPaise, promisedDate);
  audit(null, entityId, 'human', 'PROMISE_LOGGED', { promisedDate });
  res.json({ ok: true, id });
});

app.get('/api/promises', (_req, res) => {
  res.json(db.prepare(`SELECT * FROM promises_to_pay ORDER BY promised_date ASC`).all());
});

// Daily check: any promise whose date has passed and entity is still not RECOVERED -> BROKEN + escalate.
function checkBrokenPromises() {
  const overdue = db
    .prepare(`SELECT * FROM promises_to_pay WHERE status = 'PENDING' AND promised_date < date('now')`)
    .all();
  for (const promise of overdue) {
    const latestEvent = db
      .prepare(`SELECT * FROM events WHERE entity_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(promise.entity_id);
    if (latestEvent && latestEvent.status === 'RECOVERED') {
      db.prepare(`UPDATE promises_to_pay SET status = 'KEPT' WHERE id = ?`).run(promise.id);
    } else {
      db.prepare(`UPDATE promises_to_pay SET status = 'BROKEN' WHERE id = ?`).run(promise.id);
      audit(null, promise.entity_id, 'system', 'PROMISE_BROKEN', { promisedDate: promise.promised_date });
    }
  }
}
cron.schedule('0 6 * * *', checkBrokenPromises); // once a day
app.post('/internal/run-promise-check', (_req, res) => {
  checkBrokenPromises();
  res.json({ ok: true });
});

const { makeRecoveryCall } = require('./lib/voiceCall');

// ---------------------------------------------------------------------
// Voice recovery call — manually triggered per entity from the dashboard.
// Uses the latest known event for that entity to build the script.
// ---------------------------------------------------------------------
app.post('/api/call/:entityId', async (req, res) => {
  const { entityId } = req.params;
  const event = db.prepare(`SELECT * FROM events WHERE entity_id = ? ORDER BY created_at DESC LIMIT 1`).get(entityId);
  if (!event) return res.status(404).json({ error: 'No event found for this entity' });

  const toPhone = process.env.TEST_RECIPIENT_PHONE || event.customer_phone;
  const nameGuess = req.body?.name || 'there';
  const amountRupees = (event.amount_paise / 100).toFixed(2);

  const result = await makeRecoveryCall({
    to: toPhone,
    name: nameGuess,
    amountRupees,
    rootCause: event.root_cause,
    lang: event.customer_lang || 'en',
  });

  audit(event.id, entityId, 'recovery_engine', 'VOICE_CALL', {
    status: result.status,
    sid: result.sid || null,
    error: result.error || null,
  });

  res.json(result);
});

// ---------------------------------------------------------------------
// Reset — wipes all demo data so you can start a clean batch.
// ---------------------------------------------------------------------
app.post('/api/reset', (_req, res) => {
  db.exec(`DELETE FROM audit_log; DELETE FROM recovery_actions; DELETE FROM events; DELETE FROM promises_to_pay;`);
  res.json({ ok: true });
});

// Compliance control: a DND flag immediately stops all future automated
// recovery contacts for this customer/entity. Stored in a dedicated table
// (not events.status) so it can't be silently overridden by a later event
// for the same entity. runRecovery() checks this before it creates a link
// or sends WhatsApp, for every future event on this entity — permanently.
app.post('/api/dnd/:entityId', (req, res) => {
  const entityId = req.params.entityId;
  db.prepare(`INSERT OR IGNORE INTO dnd_flags (entity_id) VALUES (?)`).run(entityId);
  const result = db.prepare(`UPDATE events SET status = 'STOPPED' WHERE entity_id = ?`).run(entityId);
  audit(null, entityId, 'compliance', 'DND_FLAGGED', {
    source: 'dashboard',
    stoppedEvents: result.changes,
    timestamp: new Date().toISOString(),
  });
  res.json({ ok: true, entityId, stoppedEvents: result.changes });
});

// ---------------------------------------------------------------------
// Human Escalation Queue — cases the agent deliberately did NOT auto-act
// on (fraud risk, retry cap reached, unclassifiable, or a failed link
// creation). A human works these; resolving one closes it out without
// claiming money was "recovered" by the automation.
// ---------------------------------------------------------------------
app.get('/api/escalations', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT e.*,
        (SELECT details FROM audit_log WHERE entity_id = e.entity_id AND action IN ('ESCALATED','CAP_REACHED','LINK_CREATION_FAILED') ORDER BY created_at DESC LIMIT 1) as escalation_reason
       FROM events e WHERE e.status = 'ESCALATED' ORDER BY e.created_at DESC`
    )
    .all();
  res.json(rows);
});

app.post('/api/escalations/:eventId/resolve', (req, res) => {
  const { eventId } = req.params;
  const { note } = req.body || {};
  const result = db.prepare(`UPDATE events SET status = 'RESOLVED', resolved_at = datetime('now') WHERE id = ?`).run(eventId);
  const event = db.prepare(`SELECT entity_id FROM events WHERE id = ?`).get(eventId);
  audit(eventId, event?.entity_id, 'human', 'ESCALATION_RESOLVED', { note: note || null });
  res.json({ ok: true, updated: result.changes });
});

// ---------------------------------------------------------------------
// Dashboard API
// ---------------------------------------------------------------------
app.get('/api/dashboard', (_req, res) => {
  const atRisk = db
    .prepare(`SELECT COALESCE(SUM(amount_paise),0) as total, COUNT(*) as n FROM events`)
    .get();
  const recovered = db
    .prepare(`SELECT COALESCE(SUM(amount_paise),0) as total, COUNT(*) as n FROM events WHERE status = 'RECOVERED'`)
    .get();
  const escalated = db.prepare(`SELECT COUNT(*) as n FROM events WHERE status = 'ESCALATED'`).get();
  const byRootCause = db
    .prepare(
      `SELECT root_cause, COUNT(*) as n, COALESCE(SUM(amount_paise),0) as total_paise,
        SUM(CASE WHEN status='RECOVERED' THEN amount_paise ELSE 0 END) as recovered_paise
       FROM events GROUP BY root_cause ORDER BY total_paise DESC`
    )
    .all();
  const recentEvents = db
    .prepare(`SELECT * FROM events ORDER BY created_at DESC LIMIT 50`)
    .all();
  const recentActions = db
    .prepare(`SELECT * FROM recovery_actions ORDER BY created_at DESC LIMIT 50`)
    .all();
  const auditTrail = db
    .prepare(`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 100`)
    .all();
  const escalationQueue = db
    .prepare(
      `SELECT e.*,
        (SELECT details FROM audit_log WHERE entity_id = e.entity_id AND action IN ('ESCALATED','CAP_REACHED','LINK_CREATION_FAILED') ORDER BY created_at DESC LIMIT 1) as escalation_reason
       FROM events e WHERE e.status = 'ESCALATED' ORDER BY e.created_at DESC`
    )
    .all();

  res.json({
    summary: {
      totalAtRiskPaise: atRisk.total,
      totalAtRiskCount: atRisk.n,
      totalRecoveredPaise: recovered.total,
      totalRecoveredCount: recovered.n,
      recoveryRate: atRisk.total ? +((recovered.total / atRisk.total) * 100).toFixed(1) : 0,
      escalatedCount: escalated.n,
    },
    byRootCause,
    recentEvents,
    recentActions,
    auditTrail,
    escalationQueue,
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀 AI Revenue Recovery Agent running on http://localhost:${PORT}`);
  console.log(`   Dashboard:       http://localhost:${PORT}/`);
  console.log(`   Webhook URL:     http://localhost:${PORT}/webhook/razorpay`);
  console.log(`   Simulate events: npm run simulate\n`);
});
