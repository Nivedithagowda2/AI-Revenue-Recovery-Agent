const crypto = require('crypto');

/**
 * Verifies Razorpay's X-Razorpay-Signature header per:
 * https://razorpay.com/docs/webhooks/validate-test/
 * https://razorpay.com/docs/webhooks/faqs/
 *
 * rawBody must be the exact, unparsed request body (Buffer/string) —
 * signature verification fails if you sign a re-serialized JSON object.
 */
function isValidSignature(rawBody, signature, secret) {
  if (!secret) return true; // no secret configured (e.g. local demo) -> skip check
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature || ''));
  } catch {
    return false;
  }
}

module.exports = { isValidSignature };
