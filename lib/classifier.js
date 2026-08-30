/**
 * Rule-based root-cause classifier.
 *
 * Input: normalized fields pulled out of a Razorpay webhook payload
 *   { errorCode, errorDescription, errorReason, errorSource, eventType }
 *
 * Razorpay's real error taxonomy lives at https://razorpay.com/docs/errors/
 * These rules are deliberately simple regex matches on error_code /
 * error_reason / error_description so they're auditable (a judge can see
 * exactly why a transaction was classified a certain way) and easy to
 * extend once you're testing against real error payloads.
 *
 * Each rule returns a fixed, bounded playbook — this is what keeps the
 * agent's behaviour compliant and explainable rather than an opaque LLM call.
 */

const PLAYBOOK = {
  UPI_ISSUE: {
    label: 'UPI payment declined / timed out',
    action: 'RETRY_LINK',
    channel: 'whatsapp',
    maxAttempts: 2,
    retryDelayMinutes: 5,
    urgency: 'high',
  },
  BANK_SERVER_ERROR: {
    label: 'Bank / gateway server error (transient)',
    action: 'RETRY_LINK',
    channel: 'whatsapp',
    maxAttempts: 2,
    retryDelayMinutes: 15,
    urgency: 'medium',
  },
  INSUFFICIENT_FUNDS: {
    label: 'Insufficient balance at time of charge',
    action: 'RETRY_LINK',
    channel: 'whatsapp',
    maxAttempts: 2,
    retryDelayMinutes: 240, // give it a few hours before nudging again
    urgency: 'low',
  },
  CARD_EXPIRED_INVALID: {
    label: 'Card expired or invalid',
    action: 'UPDATE_CARD_LINK',
    channel: 'whatsapp',
    maxAttempts: 3,
    retryDelayMinutes: 24 * 60, // once a day
    urgency: 'medium',
  },
  RISK_FRAUD_BLOCK: {
    label: 'Risk engine / fraud block',
    action: 'ESCALATE_HUMAN',
    channel: null,
    maxAttempts: 0,
    retryDelayMinutes: null,
    urgency: 'high',
  },
  CHECKOUT_ABANDONED: {
    label: 'Checkout started but never completed',
    action: 'REMINDER_LINK',
    channel: 'whatsapp',
    maxAttempts: 2,
    retryDelayMinutes: 60,
    urgency: 'low',
  },
  SUBSCRIPTION_PENDING: {
    label: 'Subscription auto-charge failed, Razorpay retrying automatically',
    action: 'MONITOR',
    channel: 'whatsapp',
    maxAttempts: 1,
    retryDelayMinutes: 0,
    urgency: 'medium',
  },
  SUBSCRIPTION_HALTED: {
    label: 'Subscription halted after exhausting auto-retries',
    action: 'REACTIVATION_LINK',
    channel: 'whatsapp',
    maxAttempts: 2,
    retryDelayMinutes: 24 * 60,
    urgency: 'high',
  },
  RECEIVABLE_OVERDUE: {
    label: 'B2B invoice overdue',
    action: 'REMINDER_LINK',
    channel: 'whatsapp',
    maxAttempts: 3,
    retryDelayMinutes: 24 * 60 * 2, // every 2 days
    urgency: 'medium',
  },
  UNKNOWN_ERROR: {
    label: 'Unclassified failure',
    action: 'ESCALATE_HUMAN',
    channel: null,
    maxAttempts: 0,
    retryDelayMinutes: null,
    urgency: 'medium',
  },
};

function textBlob(fields) {
  return [fields.errorCode, fields.errorReason, fields.errorDescription, fields.errorSource]
    .filter(Boolean)
    .join(' | ')
    .toLowerCase();
}

function classify(fields) {
  const { eventType } = fields;
  const blob = textBlob(fields);

  // Event-type-driven classifications first — these are unambiguous.
  if (eventType === 'subscription.pending') {
    return finalize('SUBSCRIPTION_PENDING', 'event_type=subscription.pending');
  }
  if (eventType === 'subscription.halted') {
    return finalize('SUBSCRIPTION_HALTED', 'event_type=subscription.halted');
  }
  if (eventType === 'checkout.abandoned') {
    return finalize('CHECKOUT_ABANDONED', 'no order.paid within abandonment window');
  }
  if (eventType === 'invoice.overdue') {
    return finalize('RECEIVABLE_OVERDUE', 'event_type=invoice.overdue');
  }

  // Text-pattern classification for payment.failed events.
  if (/fraud|risk_check|blocked_by_risk/.test(blob)) {
    return finalize('RISK_FRAUD_BLOCK', `matched fraud/risk pattern in: "${blob}"`);
  }
  if (/upi|vpa|npci/.test(blob)) {
    return finalize('UPI_ISSUE', `matched UPI pattern in: "${blob}"`);
  }
  if (/gateway_error|server_error|bank.*(down|unavailable|server)|issuer.*(unavailable|timeout)|processing_error/.test(blob)) {
    return finalize('BANK_SERVER_ERROR', `matched gateway/server-error pattern in: "${blob}"`);
  }
  if (/insufficient/.test(blob)) {
    return finalize('INSUFFICIENT_FUNDS', `matched insufficient-funds pattern in: "${blob}"`);
  }
  if (/expired|invalid.*card|card.*invalid/.test(blob)) {
    return finalize('CARD_EXPIRED_INVALID', `matched card-expired/invalid pattern in: "${blob}"`);
  }

  return finalize('UNKNOWN_ERROR', `no rule matched: "${blob}"`);
}

function finalize(cause, reason) {
  return {
    rootCause: cause,
    reason,
    playbook: PLAYBOOK[cause],
  };
}

module.exports = { classify, PLAYBOOK };
