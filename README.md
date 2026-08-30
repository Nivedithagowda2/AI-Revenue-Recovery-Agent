# AI Revenue Recovery Agent

**Track3:** AI Revenue Recovery — *Find revenue that's slipping away and win it back*

An agent that detects revenue at risk, diagnoses why it's at risk, chooses the
right recovery action, and executes a **bounded** recovery workflow — from
payment failures and checkout abandonment to halted subscriptions and
overdue B2B receivables — with real Razorpay payment links, real WhatsApp
messaging, compliant stopping rules, and a full audit trail. 

---  
 
<h2> Demo Video</h2>

<a href="https://youtu.be/7Dr-cMp61xc">
  <img
    src="https://img.youtube.com/vi/7Dr-cMp61xc/hqdefault.jpg"
    alt="AI Revenue Recovery Agent Demo"
    width="800"
  />
</a>

<p>
  <a href="https://youtu.be/7Dr-cMp61xc">
    ▶️ Watch the Demo Video
  </a>
</p>

## The problem we're solving

Revenue doesn't disappear in one dramatic moment — it leaks out through
dozens of small, ordinary failures that happen every day and mostly go
unnoticed until someone runs a report weeks later:

- A customer's UPI payment times out or gets declined by their bank
- A card on file quietly expires between billing cycles
- Someone starts checkout, gets distracted, and never finishes
- A subscription auto-charge fails and nobody follows up
- A B2B invoice goes overdue and sits in an inbox unchased

Individually these look small. At scale, across thousands of transactions,
this is real money — and most businesses have no systematic way to catch
it, understand *why* it happened, and act on it before the customer moves
on or forgets.

**The manual fix** (someone in finance noticing a failed payment and
following up) doesn't scale. **The naive automated fix** (blasting the same
generic "payment failed, retry here" message at everyone) is often worse —
a fraud-flagged payment and an expired card need completely different
responses. Treating them the same either annoys customers or keeps
retrying a charge that should have been escalated to a human instead.

## What this agent does about it

1. **Detects** revenue at risk the moment it happens, via real Razorpay
   webhooks (`payment.failed`, `subscription.halted`, etc.) plus synthetic
   signals for checkout abandonment and overdue invoices.
2. **Diagnoses** the actual root cause from real error fields (`error_code`,
   `error_reason`, `error_description`) — not a guess.
3. **Chooses the right recovery action** for that specific cause: a retry
   link, an update-payment-method nudge, a reminder, or nothing at all if
   the case shouldn't be auto-contacted.
4. **Acts within strict bounds**: capped retries per entity, capped contact
   frequency per 24 hours, and immediate escalation to a human for fraud
   risk, unclassifiable failures, or anything that hits its retry cap.
5. **Proves it worked**, with a measured recovered-revenue number and a
   full audit trail of every decision made, message sent, and link created.

In a demo batch of 8 real scenarios: **₹4,00,000 flagged at risk → ₹3,00,000
(75%) recovered automatically**, with the remaining 25% correctly routed to
a Human Escalation Queue instead of being silently dropped or endlessly
retried.

## ✅ Status: real integrations, not a mockup

- **Razorpay Payment Links — LIVE and confirmed working.** Every recovery
  action calls Razorpay's real Payment Links API (`paymentLink.create`) and
  generates a genuine, clickable `rzp.io/rzp/...` link — not a placeholder.
  This has been tested end-to-end with real Razorpay test-mode keys and
  real links were generated and opened successfully.
- **WhatsApp messaging — LIVE**, via the Twilio API, with root-cause-specific
  message text in English or Hinglish, plus an automatic SMS fallback for
  the one known WhatsApp policy restriction (see *Known limitations* below).
- **Mock mode** exists purely so the whole flow is demoable with zero API
  keys — it is not a substitute for the real integration, which is already
  wired up and working.

---

## Architecture

```
Razorpay webhook ──▶ POST /webhook/razorpay
                        │
                        ▼
               signature verification (lib/verifyWebhook.js)
                        │
                        ▼
             field extraction (per event type, server.js)
                        │
                        ▼
          lib/classifier.js  — rule-based root-cause classification
          matches error_code / error_reason / error_description against
          a fixed playbook (never an opaque LLM guess — every decision
          is traceable to the pattern that triggered it)
                        │
                        ▼
        lib/recoveryEngine.js — the bounded workflow
          • checks a dedicated DND flag table (compliance, can't be
            silently overridden by a later event on the same entity)
          • checks retry cap per entity
          • checks 24h contact-frequency cap
          • ESCALATE_HUMAN playbooks (fraud, unknown errors) skip
            auto-action entirely and go straight to the escalation queue
                        │
            ┌───────────┴────────────┐
            ▼                        ▼
 lib/razorpayLinks.js        lib/whatsapp.js
 real Payment Links API      root-cause-specific message,
 call, fresh link per        English or Hinglish, with
 attempt, retry-with-        automatic SMS fallback if
 backoff on rate limits      WhatsApp blocks the message
                        │
                        ▼
           db/index.js (SQLite): events, recovery_actions,
                 audit_log, dnd_flags, promises_to_pay
                        │
                        ▼
        GET /api/dashboard → public/index.html (live dashboard)
```

---

## Root-cause playbook

| Root cause | Trigger | Action | Cap |
|---|---|---|---|
| `UPI_ISSUE` | `upi` / `vpa` / `npci` in error fields | Retry link + WhatsApp | 2 attempts, 5 min apart |
| `BANK_SERVER_ERROR` | `gateway_error` / `server_error` / bank unavailable | Retry link + WhatsApp | 2 attempts, 15 min apart |
| `INSUFFICIENT_FUNDS` | `insufficient` in error fields | Retry link + WhatsApp | 2 attempts, 4h apart |
| `CARD_EXPIRED_INVALID` | `expired` / `invalid card` | Update-card link + WhatsApp | 3 attempts, daily |
| `RISK_FRAUD_BLOCK` | `fraud` / `risk_check` | **No auto-action** — escalated to human | 0 |
| `CHECKOUT_ABANDONED` | order unpaid past threshold | Reminder link + WhatsApp | 2 attempts |
| `SUBSCRIPTION_PENDING` | `subscription.pending` webhook | Soft notify only (Razorpay auto-retries) | 1 |
| `SUBSCRIPTION_HALTED` | `subscription.halted` webhook | Reactivation link + WhatsApp | 2 attempts, daily |
| `RECEIVABLE_OVERDUE` | `invoice.overdue` | Reminder link + WhatsApp | 3 attempts, every 2 days |
| `UNKNOWN_ERROR` | no rule matched | Escalated to human | 0 |

Rules live in `lib/classifier.js` as simple, auditable regex matches —
deliberately not an LLM call, so every classification can be explained by
pointing at the exact pattern that fired.

## Compliance & stopping rules

- **Hard retry cap** per entity (`MAX_RETRIES_PER_ENTITY` in `.env`)
- **Hard contact-frequency cap** per entity per 24h (`MAX_CONTACTS_PER_24H`)
- **Fraud and unclassifiable cases never get auto-contacted** — they go
  straight to the Human Escalation Queue
- **Do-Not-Disturb**: a dedicated `dnd_flags` table (not just a status flag
  on the event) means a DND request permanently blocks all future contact
  for that entity, even across brand-new failure events
- **Every decision is logged** to `audit_log` — classification reasoning,
  link creation result, message sent (or why it wasn't), and resolution

## Human Escalation Queue

A dedicated panel lists every case the agent deliberately did **not**
auto-act on — fraud blocks, retry-cap breaches, failed link creation — each
with the real reason, so a human can review and resolve it without the
system pretending the money was "recovered" by automation it never
attempted.

## Promise-to-pay tracker (B2B receivables)

```
POST /api/promise-to-pay
{ "entityId": "inv_001", "customerName": "Acme Corp",
  "customerPhone": "+91...", "amountPaise": 5000000,
  "promisedDate": "2026-09-05" }
```

A daily cron checks promises past their date: if the entity was recovered
by then, marks it `KEPT`; otherwise marks it `BROKEN` and logs it to the
audit trail.

---

## Project structure

```
revenue-recovery-agent/
├── server.js                 Express app — webhook receiver, all API routes
├── db/
│   └── index.js              SQLite schema: events, recovery_actions,
│                              audit_log, dnd_flags, promises_to_pay
├── lib/
│   ├── classifier.js          Rule-based root-cause classifier + playbook
│   ├── recoveryEngine.js       Bounded workflow: caps, throttling, DND, escalation
│   ├── razorpayLinks.js        Razorpay Payment Links API + mock fallback
│   ├── whatsapp.js             Twilio WhatsApp send + EN/Hinglish templates
│   │                           + automatic SMS fallback
│   └── verifyWebhook.js        HMAC signature verification
├── scripts/
│   ├── simulate.js             Small demo batch (original 10-event scenario)
│   └── simulate-big.js         Realistic batch: ₹4,00,000 at risk / ₹3,00,000
│                               recovered (75%), paced to avoid rate limits
├── public/
│   └── index.html              Live dashboard: totals, charts, root-cause
│                               breakdown, escalation queue, audit trail
├── .env.example                All environment variables, documented
└── package.json
```

---

## Running in two modes

- **Mock mode (default, zero setup)** — every payment link and WhatsApp
  message is generated and logged exactly as it would be live, so the full
  flow is demoable with no API keys at all.
- **Live mode** — drop in real Razorpay + Twilio credentials and the exact
  same code paths call the real APIs instead. No code changes needed to
  switch.

### Quick start

```bash
npm install
cp .env.example .env      # fill in real keys for live mode, or leave blank for mock
npm start                 # http://localhost:3000
```

In a second terminal, fire a realistic batch of scenarios:

```bash
node scripts/simulate-big.js
```

Open **http://localhost:3000** — the dashboard auto-refreshes every 5s.

To reset demo data between runs:

```bash
curl -s -X POST http://localhost:3000/api/reset
```
*(On Windows PowerShell, use: `Invoke-WebRequest -Uri http://localhost:3000/api/reset -Method POST`)*

### Environment variables

See `.env.example` for the full, commented list. Key ones:

| Variable | Purpose |
|---|---|
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Real Razorpay test-mode API keys |
| `RAZORPAY_WEBHOOK_SECRET` | Verifies incoming webhook signatures |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Twilio auth |
| `TWILIO_WHATSAPP_FROM` | Twilio's WhatsApp sender number (sandbox or approved) — **not** your own number |
| `TWILIO_SMS_FROM` | Twilio number used for the automatic SMS fallback |
| `TEST_RECIPIENT_PHONE` | Routes all demo messages to one real, verified number instead of fake test data |
| `MAX_RETRIES_PER_ENTITY` / `MAX_CONTACTS_PER_24H` | Compliance caps |
| `FORCE_MOCK` | Force mock mode even if keys are present |

### Going live with real Razorpay

1. Dashboard → Settings → Webhooks → point at
   `https://<your-url>/webhook/razorpay`, subscribed to `payment.failed`,
   `payment.captured`, `order.paid`, `subscription.pending`,
   `subscription.halted`.
2. Copy the webhook secret and API key/secret into `.env`.
3. For localhost demos, tunnel with `ngrok http 3000` and use that URL.

### Going live with real WhatsApp

1. Twilio Console → Messaging → Try WhatsApp (Sandbox is enough for a demo).
2. Join the sandbox from your own WhatsApp by sending the join code shown.
3. Verify your number under Phone Numbers → Verified Caller IDs (required
   for Twilio trial accounts to deliver anything to it).
4. Fill in the Twilio variables in `.env`.

---

## Known limitations (by design, not bugs)

- **Razorpay test-mode accounts have a payment-link quota** (commonly 30)
  that resets on Razorpay's own schedule, not instantly. Repeated demo
  runs will eventually hit it — space out full batch runs.
- **WhatsApp requires an approved message template for business-initiated
  messages** sent outside a 24-hour customer session window (a Meta/WhatsApp
  policy, not a Twilio bug). This agent automatically falls back to SMS
  when that happens, so the customer still gets contacted.
- **Twilio trial accounts** only deliver to explicitly verified numbers —
  set `TEST_RECIPIENT_PHONE` to a verified number to see real deliveries
  during a demo.

## Tech stack

Node.js, Express, better-sqlite3, Razorpay Node SDK, Twilio Node SDK,
node-cron, vanilla HTML/CSS/JS dashboard (no frontend framework).
