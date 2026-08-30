const twilio = require('twilio');

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_VOICE_FROM,
  TWILIO_WHATSAPP_FROM,
  FORCE_MOCK,
} = process.env;

// Voice calls need a Twilio *voice-capable* number. In a pinch, the same
// Twilio number used for WhatsApp sandbox is NOT voice-capable, so this
// is deliberately a separate env var — set TWILIO_VOICE_FROM to a real
// Twilio phone number (Console -> Phone Numbers) if you want live calls.
const FROM = TWILIO_VOICE_FROM || null;

const isLive = FORCE_MOCK !== 'true' && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && FROM;

const client = isLive ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

/**
 * Builds the spoken script for a recovery call. Kept short and factual —
 * a real collections call should never sound threatening or evasive about
 * why it's calling.
 */
function buildScript({ name, amountRupees, rootCause, lang }) {
  const reasonHi = {
    UPI_ISSUE: 'aapka UPI payment complete nahi ho paya',
    BANK_SERVER_ERROR: 'bank ke server mein ek temporary dikkat aayi thi',
    INSUFFICIENT_FUNDS: 'balance kam hone ki wajah se payment nahi ho paya',
    CARD_EXPIRED_INVALID: 'aapka card expire ho gaya hai',
    CHECKOUT_ABANDONED: 'aapka order pending reh gaya',
    SUBSCRIPTION_HALTED: 'aapka subscription pause ho gaya hai',
    RECEIVABLE_OVERDUE: 'aapka invoice overdue hai',
  };
  const reasonEn = {
    UPI_ISSUE: 'your UPI payment could not be completed',
    BANK_SERVER_ERROR: 'there was a temporary issue at the bank\'s end',
    INSUFFICIENT_FUNDS: 'the payment could not go through due to insufficient balance',
    CARD_EXPIRED_INVALID: 'your card on file has expired',
    CHECKOUT_ABANDONED: 'your order is still pending payment',
    SUBSCRIPTION_HALTED: 'your subscription has been paused',
    RECEIVABLE_OVERDUE: 'your invoice is overdue',
  };

  if (lang === 'hi') {
    return `Namaste ${name}. Yeh ek automated call hai aapke pending payment ke baare mein. ${reasonHi[rootCause] || 'aapka payment pending hai'}, aur is samay aapke dues rupaye ${amountRupees} hain. Hum aapko WhatsApp par ek payment link bhej rahe hain, jahan se aap turant pay kar sakte hain. Dhanyavaad.`;
  }
  return `Hello ${name}. This is an automated call regarding your pending payment. ${reasonEn[rootCause] || 'Your payment is pending'}, and your current dues are ${amountRupees} rupees. We are sending a payment link to your WhatsApp so you can pay right away. Thank you.`;
}

/**
 * Places a recovery call using Twilio's Voice API with inline TwiML
 * (no hosted TwiML endpoint required). Falls back to a mock/log-only
 * result if Twilio voice isn't configured.
 */
async function makeRecoveryCall({ to, name, amountRupees, rootCause, lang = 'en' }) {
  const script = buildScript({ name, amountRupees, rootCause, lang });

  if (!isLive) {
    return { status: 'MOCKED', script, sid: `MOCK_CALL_${Date.now()}` };
  }

  const twiml = `<Response><Say voice="Polly.Aditi" language="${lang === 'hi' ? 'hi-IN' : 'en-IN'}">${escapeXml(script)}</Say></Response>`;

  try {
    const call = await client.calls.create({
      from: FROM,
      to: `+${String(to).replace(/^\+/, '')}`,
      twiml,
    });
    return { status: 'INITIATED', script, sid: call.sid };
  } catch (err) {
    const detail = `Twilio ${err.code || 'ERR'}: ${err.message || String(err)}`;
    console.error('Voice call failed:', detail);
    if (err.code === 21219 || err.code === 21211) {
      console.error(
        'Hint: trial accounts can only call numbers verified in Console -> Phone Numbers -> Verified Caller IDs.'
      );
    }
    return { status: 'FAILED', script, error: detail };
  }
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { makeRecoveryCall, isLive };
