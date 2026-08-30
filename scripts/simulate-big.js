/**
 * A realistic, demo-ready batch: ₹4,00,000 total revenue at risk,
 * ₹3,00,000 recovered (75% recovery rate) across 8 cases spanning
 * every root cause in the playbook.
 *
 * Run `npm run reset` first if you want a clean dashboard, then:
 *   node scripts/simulate-big.js
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function paymentFailedEvent({ orderId, paymentId, amount, email, phone, name, errorCode, errorReason, errorDescription, lang }) {
  return {
    event: 'payment.failed',
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: orderId,
          amount,
          currency: 'INR',
          email,
          contact: phone,
          error_code: errorCode,
          error_reason: errorReason,
          error_description: errorDescription,
          error_source: 'customer',
          notes: { customer_name: name, lang },
        },
      },
    },
  };
}

function paymentCapturedEvent({ orderId, paymentId, amount }) {
  return {
    event: 'payment.captured',
    payload: { payment: { entity: { id: paymentId, order_id: orderId, amount, currency: 'INR' } } },
  };
}

function subscriptionEvent(type, { subId, phone, email, amountPaise }) {
  return {
    event: type,
    payload: { subscription: { entity: { id: subId, customer_id: `cust_${subId}`, notes: { phone, email, amount_paise: amountPaise } } } },
  };
}

function invoiceOverdueEvent({ invoiceId, amount, email, phone, name }) {
  return {
    event: 'invoice.overdue',
    payload: {
      invoice: {
        entity: { id: invoiceId, amount, customer_details: { email, contact: phone } },
        notes: { customer_name: name },
      },
    },
  };
}

async function postWebhook(evt) {
  return post('/webhook/razorpay', evt);
}

async function run() {
  console.log('Posting an 8-case batch totalling ₹4,00,000 at risk...\n');

  // 1. UPI decline — recovers on retry. ₹90,000
  console.log('₹90,000  UPI decline (Rohan)      -> recovers');
  await postWebhook(paymentFailedEvent({
    orderId: 'order_BIG_UPI01', paymentId: 'pay_BIG_UPI01', amount: 9000000,
    email: 'rohan@example.com', phone: '+919810011001', name: 'Rohan',
    errorCode: 'BAD_REQUEST_ERROR', errorReason: 'upi_declined', errorDescription: 'UPI transaction declined by NPCI', lang: 'hi',
  }));
  await postWebhook(paymentCapturedEvent({ orderId: 'order_BIG_UPI01', paymentId: 'pay_BIG_UPI01_retry', amount: 9000000 }));
  await sleep(1500); // pace real API calls to avoid bursting Razorpay's rate limit

  // 2. Bank/gateway server error — recovers. ₹70,000
  console.log('₹70,000  Bank server error (Priya) -> recovers');
  await postWebhook(paymentFailedEvent({
    orderId: 'order_BIG_GW02', paymentId: 'pay_BIG_GW02', amount: 7000000,
    email: 'priya@example.com', phone: '+919810011002', name: 'Priya',
    errorCode: 'GATEWAY_ERROR', errorReason: 'gateway_error', errorDescription: 'Bank server was unavailable, please retry', lang: 'en',
  }));
  await postWebhook(paymentCapturedEvent({ orderId: 'order_BIG_GW02', paymentId: 'pay_BIG_GW02_retry', amount: 7000000 }));
  await sleep(1500); // pace real API calls to avoid bursting Razorpay's rate limit

  // 3. Insufficient funds — recovers. ₹40,000
  console.log('₹40,000  Insufficient funds (Meera) -> recovers');
  await postWebhook(paymentFailedEvent({
    orderId: 'order_BIG_IF03', paymentId: 'pay_BIG_IF03', amount: 4000000,
    email: 'meera@example.com', phone: '+919810011003', name: 'Meera',
    errorCode: 'BAD_REQUEST_ERROR', errorReason: 'insufficient_funds', errorDescription: 'Insufficient balance in account', lang: 'hi',
  }));
  await postWebhook(paymentCapturedEvent({ orderId: 'order_BIG_IF03', paymentId: 'pay_BIG_IF03_retry', amount: 4000000 }));
  await sleep(1500); // pace real API calls to avoid bursting Razorpay's rate limit

  // 4. Expired card — recovers after update. ₹60,000
  console.log('₹60,000  Expired card (Arjun)      -> recovers');
  await postWebhook(paymentFailedEvent({
    orderId: 'order_BIG_CARD04', paymentId: 'pay_BIG_CARD04', amount: 6000000,
    email: 'arjun@example.com', phone: '+919810011004', name: 'Arjun',
    errorCode: 'BAD_REQUEST_ERROR', errorReason: 'card_expired', errorDescription: 'The card has expired', lang: 'en',
  }));
  await postWebhook(paymentCapturedEvent({ orderId: 'order_BIG_CARD04', paymentId: 'pay_BIG_CARD04_retry', amount: 6000000 }));
  await sleep(1500); // pace real API calls to avoid bursting Razorpay's rate limit

  // 5. Checkout abandoned — recovers via reminder. ₹40,000
  console.log('₹40,000  Checkout abandoned (Divya) -> recovers');
  await post('/internal/mark-abandoned', {
    orderId: 'order_BIG_ABANDON05', amountPaise: 4000000, email: 'divya@example.com', phone: '+919810011005', name: 'Divya',
  });
  await postWebhook(paymentCapturedEvent({ orderId: 'order_BIG_ABANDON05', paymentId: 'pay_BIG_ABANDON05', amount: 4000000 }));
  await sleep(1500); // pace real API calls to avoid bursting Razorpay's rate limit

  // 6. Risk/fraud block — NOT recovered, escalated to human. ₹55,000
  console.log('₹55,000  Risk/fraud block (Unknown) -> escalated, no auto-action');
  await postWebhook(paymentFailedEvent({
    orderId: 'order_BIG_RISK06', paymentId: 'pay_BIG_RISK06', amount: 5500000,
    email: 'unknown@example.com', phone: '+919810011006', name: 'Unknown',
    errorCode: 'BAD_REQUEST_ERROR', errorReason: 'fraud_suspected', errorDescription: 'Blocked by risk engine', lang: 'en',
  }));

  // 7. Subscription halted — NOT recovered yet (customer hasn't reactivated). ₹30,000
  console.log('₹30,000  Subscription halted (Kabir) -> pending reactivation');
  await postWebhook(subscriptionEvent('subscription.halted', { subId: 'sub_BIG07', phone: '+919810011007', email: 'kabir@example.com', amountPaise: 3000000 }));
  await sleep(1500); // pace real API calls to avoid bursting Razorpay's rate limit

  // 8. B2B receivable overdue — NOT recovered yet, reminder sent. ₹15,000
  console.log('₹15,000  Receivable overdue (Acme Traders) -> reminder sent, awaiting payment');
  await postWebhook(invoiceOverdueEvent({ invoiceId: 'inv_BIG08', amount: 1500000, email: 'accounts@acmetraders.com', phone: '+919810011008', name: 'Acme Traders' }));
  await sleep(1500); // pace real API calls to avoid bursting Razorpay's rate limit

  console.log('\n✅ Batch complete: ₹4,00,000 at risk, ₹3,00,000 recovered (75%), 3 cases still open.');
  console.log('   Open http://localhost:3000 to see the dashboard.\n');
}

run().catch((e) => {
  console.error('Simulation failed:', e);
  process.exit(1);
});
