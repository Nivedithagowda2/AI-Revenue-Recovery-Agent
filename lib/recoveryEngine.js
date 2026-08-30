const { v4: uuid } = require('uuid');
const db = require('../db');
const { createRecoveryLink } = require('./razorpayLinks');
const { sendWhatsApp } = require('./whatsapp');

const MAX_RETRIES_PER_ENTITY = parseInt(process.env.MAX_RETRIES_PER_ENTITY || '2', 10);
const MAX_CONTACTS_PER_24H = parseInt(process.env.MAX_CONTACTS_PER_24H || '1', 10);

function audit(eventId, entityId, actor, action, details) {
  db.prepare(
    `INSERT INTO audit_log (id, event_id, entity_id, actor, action, details) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(uuid(), eventId, entityId, actor, action, typeof details === 'string' ? details : JSON.stringify(details));
}

function priorAttempts(entityId) {
  return db.prepare(`SELECT * FROM recovery_actions WHERE entity_id = ? ORDER BY created_at ASC`).all(entityId);
}

function contactedInLast24h(entityId) {
  return db
    .prepare(
      `SELECT COUNT(*) as c FROM recovery_actions WHERE entity_id = ? AND created_at >= datetime('now', '-1 day')`
    )
    .get(entityId).c;
}

function isOptedOut(entityId) {
  // Checks a dedicated DND table rather than events.status — a new event
  // for this entity would otherwise become the "latest" row (status
  // DETECTED) and silently override an earlier STOPPED flag.
  return !!db.prepare(`SELECT 1 FROM dnd_flags WHERE entity_id = ?`).get(entityId);
}

/**
 * Executes ONE bounded recovery action for a classified event.
 * Enforces:
 *  - max retries per entity (playbook-specific, capped globally by MAX_RETRIES_PER_ENTITY)
 *  - max contacts per 24h
 *  - immediate stop if the entity was marked opted-out / disputed
 *  - immediate escalate-to-human for playbooks that don't allow auto-action
 */
async function runRecovery({ eventId, entityId, rootCause, playbook, amountPaise, name, email, phone, lang }) {
  // For demos: route every WhatsApp/call to one real, verified number
  // instead of the fake numbers baked into the simulator scripts, so you
  // can actually see the messages land instead of hitting Twilio trial
  // restrictions on fake destinations.
  const effectivePhone = process.env.TEST_RECIPIENT_PHONE || phone;

  if (isOptedOut(entityId)) {
    audit(eventId, entityId, 'recovery_engine', 'STOPPED', 'entity previously marked STOPPED / opted out');
    return { status: 'STOPPED' };
  }

  if (playbook.action === 'ESCALATE_HUMAN') {
    audit(eventId, entityId, 'recovery_engine', 'ESCALATED', `root_cause=${rootCause} requires human review, no auto-action taken`);
    db.prepare(`UPDATE events SET status = 'ESCALATED' WHERE id = ?`).run(eventId);
    return { status: 'ESCALATED' };
  }

  if (playbook.action === 'MONITOR') {
    // e.g. subscription.pending — Razorpay is already auto-retrying, we just log + soft-notify once.
    const attempts = priorAttempts(entityId);
    if (attempts.length >= 1) {
      audit(eventId, entityId, 'recovery_engine', 'SKIPPED', 'already sent one monitor notice for this entity');
      return { status: 'MONITORED_NO_REPEAT' };
    }
  }

  const attempts = priorAttempts(entityId);
  const cap = Math.min(playbook.maxAttempts, MAX_RETRIES_PER_ENTITY + 1); // +1 because "attempts" includes the informational one
  if (attempts.length >= cap) {
    audit(eventId, entityId, 'recovery_engine', 'CAP_REACHED', `${attempts.length} attempts already made, cap=${cap}. Escalating to human.`);
    db.prepare(`UPDATE events SET status = 'ESCALATED' WHERE id = ?`).run(eventId);
    return { status: 'CAP_REACHED_ESCALATED' };
  }

  if (contactedInLast24h(entityId) >= MAX_CONTACTS_PER_24H) {
    audit(eventId, entityId, 'recovery_engine', 'THROTTLED', `contact cap of ${MAX_CONTACTS_PER_24H}/24h reached, deferring`);
    return { status: 'THROTTLED' };
  }

  // 1. Create a fresh payment link (never resend a dead order id).
  const link = await createRecoveryLink({
    amountPaise,
    name,
    email,
    phone,
    description: `Recovery: ${playbook.label}`,
    // Razorpay keeps reference_id unique even after local demo data is reset.
    // Use a short, fresh ID for every link instead of reusing the order ID.
    referenceId: `rr_${Date.now()}_${attempts.length + 1}`,
  });
  audit(eventId, entityId, 'recovery_engine', 'LINK_CREATED', link);

  // If link creation genuinely failed, do NOT send a WhatsApp message —
  // a message with an "undefined" link is worse than no message at all.
  // Escalate to a human instead of silently failing.
  if (!link.short_url) {
    audit(eventId, entityId, 'recovery_engine', 'LINK_CREATION_FAILED', {
      error: link.error || 'unknown error',
    });
    db.prepare(`UPDATE events SET status = 'ESCALATED' WHERE id = ?`).run(eventId);
    return { status: 'LINK_FAILED_ESCALATED', link };
  }

  // 2. Send WhatsApp nudge with root-cause-specific copy in the customer's language.
  const amountRupees = (amountPaise / 100).toFixed(2);
  const wa = await sendWhatsApp({
    to: effectivePhone,
    rootCause,
    lang,
    vars: { name: name || 'there', amount: amountRupees, link: link.short_url },
  });
  audit(eventId, entityId, 'recovery_engine', 'WHATSAPP_SENT', {
    status: wa.status,
    sid: wa.sid || null,
    error: wa.error || null,
  });

  db.prepare(
    `INSERT INTO recovery_actions
      (id, event_id, entity_id, action_type, attempt_number, payment_link_id, payment_link_url, channel, message_sent, message_lang, delivery_status, amount_paise, error_detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuid(),
    eventId,
    entityId,
    playbook.action,
    attempts.length + 1,
    link.id || null,
    link.short_url || null,
    'whatsapp',
    wa.message,
    lang,
    wa.status,
    amountPaise,
    [
      link.error ? `Razorpay: ${link.error}` : null,
      wa.error ? `Twilio: ${wa.error}` : null,
    ]
      .filter(Boolean)
      .join(' | ') || null
  );

  db.prepare(`UPDATE events SET status = 'ACTIONED' WHERE id = ?`).run(eventId);

  return { status: 'ACTIONED', link, whatsapp: wa, attemptNumber: attempts.length + 1 };
}

/**
 * Call this when a payment.captured / order.paid event arrives for an
 * entity that has open recovery events — marks them RECOVERED and stamps
 * the amount into the dashboard's "money recovered" total.
 */
function markRecovered(entityId, capturedAmountPaise) {
  const rows = db
    .prepare(`SELECT * FROM events WHERE entity_id = ? AND status IN ('DETECTED','ACTIONED','ESCALATED')`)
    .all(entityId);
  for (const row of rows) {
    db.prepare(`UPDATE events SET status = 'RECOVERED', resolved_at = datetime('now') WHERE id = ?`).run(row.id);
    audit(row.id, entityId, 'system', 'RECOVERED', { capturedAmountPaise });
  }
  return rows.length;
}

module.exports = { runRecovery, markRecovered, audit };
