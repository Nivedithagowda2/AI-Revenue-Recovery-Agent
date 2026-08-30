const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'recovery.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  razorpay_event_id TEXT,
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT NOT NULL,          -- payment_id / order_id / subscription_id / invoice_id
  amount_paise INTEGER,
  currency TEXT DEFAULT 'INR',
  customer_email TEXT,
  customer_phone TEXT,
  customer_lang TEXT DEFAULT 'en',  -- 'en' or 'hi' (hinglish)
  raw_payload TEXT,
  root_cause TEXT,
  recommended_action TEXT,
  status TEXT DEFAULT 'DETECTED',   -- DETECTED, ACTIONED, RECOVERED, ESCALATED, STOPPED, EXPIRED
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS recovery_actions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action_type TEXT NOT NULL,        -- RETRY_LINK, UPDATE_CARD_LINK, REMINDER_LINK, REACTIVATION_LINK, ESCALATE_HUMAN, MONITOR
  attempt_number INTEGER NOT NULL,
  payment_link_id TEXT,
  payment_link_url TEXT,
  channel TEXT,                     -- whatsapp, sms, email
  message_sent TEXT,
  message_lang TEXT,
  delivery_status TEXT,             -- SENT, MOCKED, FAILED
  amount_paise INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(event_id) REFERENCES events(id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  event_id TEXT,
  entity_id TEXT,
  actor TEXT NOT NULL,              -- 'system', 'classifier', 'recovery_engine', 'human'
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS promises_to_pay (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  customer_name TEXT,
  customer_phone TEXT,
  amount_paise INTEGER,
  promised_date TEXT NOT NULL,
  status TEXT DEFAULT 'PENDING',    -- PENDING, KEPT, BROKEN
  created_at TEXT DEFAULT (datetime('now'))
);

-- Dedicated DND table. Kept separate from events.status because a new
-- event for the same entity would otherwise become the "latest" row and
-- silently override a STOPPED flag set by an earlier DND request.
CREATE TABLE IF NOT EXISTS dnd_flags (
  entity_id TEXT PRIMARY KEY,
  flagged_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_id);
CREATE INDEX IF NOT EXISTS idx_actions_entity ON recovery_actions(entity_id);
`);

// Safe migration for DBs created before error_detail existed.
try {
  db.exec(`ALTER TABLE recovery_actions ADD COLUMN error_detail TEXT`);
} catch (e) {
  /* column already exists — fine */
}

module.exports = db;
