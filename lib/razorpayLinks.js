const Razorpay = require('razorpay');

const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, FORCE_MOCK } = process.env;

const isLive = FORCE_MOCK !== 'true' && RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET;

const instance = isLive
  ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
  : null;

/**
 * Creates a fresh Razorpay Payment Link for a recovery attempt.
 * Docs: https://razorpay.com/docs/api/payments/payment-links/create/
 *
 * A *new* link is always created rather than resending a dead order id —
 * a failed/expired order cannot be re-paid against the same order_id.
 */
async function createRecoveryLink({ amountPaise, currency = 'INR', name, email, phone, description, referenceId }) {
  if (!isLive) {
    // Mock mode — return a realistic-looking Razorpay payment link shape.
    const mockId = `plink_MOCK${Date.now()}`;
    return {
      status: 'MOCKED',
      id: mockId,
      short_url: `https://rzp.io/i/mock-${mockId}`,
      amount: amountPaise,
      currency,
    };
  }

  const attempt = async () => {
    const link = await instance.paymentLink.create({
      amount: amountPaise,
      currency,
      accept_partial: false,
      description: description || 'Payment recovery',
      customer: {
        name,
        email,
        contact: phone,
      },
      notify: { sms: false, email: false }, // we notify via our own WhatsApp flow
      reminder_enable: true,
      reference_id: referenceId,
      notes: {
        source: 'ai-revenue-recovery-agent',
      },
    });
    return { status: 'CREATED', id: link.id, short_url: link.short_url, amount: link.amount, currency: link.currency };
  };

  try {
    return await attempt();
  } catch (err) {
    const statusCode = err?.statusCode || err?.status;
    const isRateLimit = statusCode === 429 || /too many requests|rate limit/i.test(err?.error?.description || '');

    if (isRateLimit) {
      // Razorpay test-mode accounts (especially new ones) often enforce a
      // per-MINUTE quota, not a per-second burst limit. Retrying after only
      // a few seconds won't clear that — so we wait long enough to actually
      // cross a minute boundary once, rather than stacking short retries.
      console.error('Razorpay rate limit hit, waiting 45s before one retry (this is usually a per-minute account quota, not a burst limit)...');
      await new Promise((r) => setTimeout(r, 45000));
      try {
        return await attempt();
      } catch (retryErr) {
        const detail2 =
          retryErr?.error?.description ||
          retryErr?.error?.reason ||
          (typeof retryErr.message === 'string' ? retryErr.message : JSON.stringify(retryErr));
        console.error('Razorpay payment link creation failed after waiting:', detail2);
        return { status: 'FAILED', error: `${detail2} (this usually clears on its own after ~1-2 minutes of no requests — try again shortly, or space out your batch further)` };
      }
    }

    // Razorpay's Node SDK throws errors whose real message lives at
    // err.error.description, not err.message — using err.message directly
    // (or new Error(err) upstream) is how you end up with "[object Object]".
    const detail =
      err?.error?.description ||
      err?.error?.reason ||
      (typeof err.message === 'string' ? err.message : JSON.stringify(err));
    console.error('Razorpay payment link creation failed:', detail);
    return { status: 'FAILED', error: detail };
  }
}

module.exports = { createRecoveryLink, isLive };
