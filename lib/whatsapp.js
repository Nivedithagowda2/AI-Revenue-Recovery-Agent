const twilio = require('twilio');

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  FORCE_MOCK,
} = process.env;

const isLive =
  FORCE_MOCK !== 'true' && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_WHATSAPP_FROM;

const client = isLive ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

// ---- Message templates -----------------------------------------------
// Each template gets {amount, link, name, cause-specific reason} interpolated.
// 'en' = plain English, 'hi' = Hinglish (Latin-script Hindi/English mix),
// which is one of the track's example directions ("Hinglish voice recovery").

const TEMPLATES = {
  UPI_ISSUE: {
    en: (v) =>
      `Hi ${v.name}, your UPI payment of ₹${v.amount} didn't go through (looks like a bank/UPI-side decline). No charge was made. You can complete it safely here: ${v.link}\nIf UPI keeps failing, try card or netbanking on the same link.`,
    hi: (v) =>
      `Hi ${v.name}, aapka ₹${v.amount} ka UPI payment complete nahi hua (bank ki taraf se decline hua lagta hai). Koi paisa cut nahi hua hai. Yahan se dobara try kar sakte ho: ${v.link}\nAgar UPI baar-baar fail ho raha hai, to isi link par card ya netbanking try karo.`,
  },
  BANK_SERVER_ERROR: {
    en: (v) =>
      `Hi ${v.name}, your payment of ₹${v.amount} failed due to a temporary issue on the bank/payment gateway's side — not something you did wrong. Please retry here: ${v.link}`,
    hi: (v) =>
      `Hi ${v.name}, ₹${v.amount} ka payment ek temporary bank/gateway issue ki wajah se fail ho gaya — yeh aapki taraf se galti nahi thi. Please yahan dobara try karein: ${v.link}`,
  },
  INSUFFICIENT_FUNDS: {
    en: (v) =>
      `Hi ${v.name}, your payment of ₹${v.amount} couldn't be completed due to insufficient balance. Whenever you're ready, you can pay here: ${v.link}`,
    hi: (v) =>
      `Hi ${v.name}, balance kam hone ki wajah se ₹${v.amount} ka payment nahi ho paya. Jab bhi ready ho, yahan se pay kar dena: ${v.link}`,
  },
  CARD_EXPIRED_INVALID: {
    en: (v) =>
      `Hi ${v.name}, the card on file seems to be expired or invalid, so we couldn't charge ₹${v.amount}. Please update your payment method here: ${v.link}`,
    hi: (v) =>
      `Hi ${v.name}, aapka saved card expire ho gaya lagta hai, isliye ₹${v.amount} charge nahi ho paya. Please apna payment method yahan update kar dijiye: ${v.link}`,
  },
  CHECKOUT_ABANDONED: {
    en: (v) =>
      `Hi ${v.name}, looks like your order of ₹${v.amount} is still waiting! Complete your payment here before it expires: ${v.link}`,
    hi: (v) =>
      `Hi ${v.name}, aapka ₹${v.amount} ka order abhi bhi pending hai! Expire hone se pehle yahan se payment complete kar lijiye: ${v.link}`,
  },
  SUBSCRIPTION_PENDING: {
    en: (v) =>
      `Hi ${v.name}, we're automatically retrying your subscription charge of ₹${v.amount}. No action needed right now — we'll let you know if we need you to update your card.`,
    hi: (v) =>
      `Hi ${v.name}, aapke subscription ka ₹${v.amount} charge hum automatically retry kar rahe hain. Abhi kuch karne ki zaroorat nahi — agar card update karna pade to hum bata denge.`,
  },
  SUBSCRIPTION_HALTED: {
    en: (v) =>
      `Hi ${v.name}, your subscription has been paused after repeated charge failures on ₹${v.amount}. Reactivate anytime here: ${v.link}`,
    hi: (v) =>
      `Hi ${v.name}, baar-baar charge fail hone ki wajah se aapka subscription (₹${v.amount}) pause ho gaya hai. Jab chahen yahan se reactivate kar sakte hain: ${v.link}`,
  },
  RECEIVABLE_OVERDUE: {
    en: (v) =>
      `Hi ${v.name}, this is a reminder that an invoice of ₹${v.amount} is overdue. Please settle it here at your earliest: ${v.link}\nReply with a date if you'd like to schedule payment instead.`,
    hi: (v) =>
      `Hi ${v.name}, ₹${v.amount} ka invoice overdue hai, yeh ek reminder hai. Please jald se jald yahan se clear kar dijiye: ${v.link}\nAgar koi specific date par pay karna chahte hain to reply mein date bata dijiye.`,
  },
};

function renderMessage(rootCause, lang, vars) {
  const tpl = TEMPLATES[rootCause];
  if (!tpl) return `Hi ${vars.name}, please complete your pending payment of ₹${vars.amount} here: ${vars.link}`;
  const fn = tpl[lang] || tpl.en;
  return fn(vars);
}

async function sendWhatsApp({ to, rootCause, lang = 'en', vars }) {
  const message = renderMessage(rootCause, lang, vars);

  if (!isLive) {
    // Mock mode: log what would have been sent so the flow is fully demoable
    // without live Twilio credentials.
    return {
      status: 'MOCKED',
      message,
      sid: `MOCK_${Date.now()}`,
    };
  }

  try {
    const result = await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: `whatsapp:${to}`,
      body: message,
    });
    return { status: 'SENT', message, sid: result.sid };
  } catch (err) {
    // Twilio errors carry a numeric `code` and human `message` — surface both
    // instead of letting them collapse into "[object Object]" downstream.
    const detail = `Twilio ${err.code || 'ERR'}: ${err.message || String(err)}`;
    console.error('WhatsApp send failed:', detail);
    if (err.code === 63007 || err.code === 63016) {
      console.error(
        'Hint: this usually means the recipient number has not joined your Twilio WhatsApp Sandbox yet. ' +
          'Send the sandbox join code from that WhatsApp number first.'
      );
    }
    if (err.code === 20003 || err.status === 401) {
      console.error('Hint: this usually means TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN in .env are wrong.');
    }
    return { status: 'FAILED', message, error: detail };
  }
}

module.exports = { sendWhatsApp, renderMessage, isLive };
