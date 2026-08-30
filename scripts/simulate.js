/**
 * Simulates a batch of real-world revenue-leak scenarios by POSTing
 * Razorpay-shaped webhook payloads to your locally running server.
 * This is what you run live during the demo to show the "batch of
 * money recovered" number climb on the dashboard.
 *
 * Usage: node scripts/simulate.js   (server must already be running: npm start)
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';

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
    payload: {
      payment: { entity: { id: paymentId, order_id: orderId, amount, currency: 'INR' } },
    },
  };
}

function subscriptionEvent(type, { subId, phone, email, amountPaise }) {
  return {
    event: type,
    payload: {
      subscription: {
        entity: { id: subId, customer_id: `cust_${subId}`, notes: { phone, email, amount_paise: amountPaise } },
      },
    },
  };
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function postWebhook(evt) {
  return post('/webhook/razorpay', evt);
}

async function run() {
  console.log('--- Simulating: UPI decline, then customer retries successfully ---');
  await postWebhook(
    paymentFailedEvent({
      orderId: 'order_UPI001',
      paymentId: 'pay_UPI001',
      amount: 149900, // ₹1,499.00
      email: 'riya@example.com',
      phone: '+919810000001',
      name: 'Riya',
      errorCode: 'BAD_REQUEST_ERROR',
      errorReason: 'upi_declined',
      errorDescription: 'UPI transaction declined by NPCI',
      lang: 'hi',
    })
  );

  console.log('--- Simulating: Bank/gateway server error (transient) ---');
  await postWebhook(
    paymentFailedEvent({
      orderId: 'order_GW002',
      paymentId: 'pay_GW002',
      amount: 249900,
      email: 'aman@example.com',
      phone: '+919810000002',
      name: 'Aman',
      errorCode: 'GATEWAY_ERROR',
      errorReason: 'gateway_error',
      errorDescription: 'Bank server was unavailable, please retry',
      lang: 'en',
    })
  );
  // Simulate: this one recovers on retry
  await postWebhook(paymentCapturedEvent({ orderId: 'order_GW002', paymentId: 'pay_GW002_retry', amount: 249900 }));

  console.log('--- Simulating: Insufficient funds ---');
  await postWebhook(
    paymentFailedEvent({
      orderId: 'order_IF003',
      paymentId: 'pay_IF003',
      amount: 99900,
      email: 'sana@example.com',
      phone: '+919810000003',
      name: 'Sana',
      errorCode: 'BAD_REQUEST_ERROR',
      errorReason: 'insufficient_funds',
      errorDescription: 'Insufficient balance in account',
      lang: 'hi',
    })
  );

  console.log('--- Simulating: Expired card ---');
  await postWebhook(
    paymentFailedEvent({
      orderId: 'order_CARD004',
      paymentId: 'pay_CARD004',
      amount: 599900,
      email: 'vikram@example.com',
      phone: '+919810000004',
      name: 'Vikram',
      errorCode: 'BAD_REQUEST_ERROR',
      errorReason: 'card_expired',
      errorDescription: 'The card has expired',
      lang: 'en',
    })
  );

  console.log('--- Simulating: Risk/fraud block (should escalate to human, no auto action) ---');
  await postWebhook(
    paymentFailedEvent({
      orderId: 'order_RISK005',
      paymentId: 'pay_RISK005',
      amount: 1299900,
      email: 'unknown@example.com',
      phone: '+919810000005',
      name: 'Unknown',
      errorCode: 'BAD_REQUEST_ERROR',
      errorReason: 'fraud_suspected',
      errorDescription: 'Blocked by risk engine',
      lang: 'en',
    })
  );

  console.log('--- Simulating: Checkout abandoned ---');
  await post('/internal/mark-abandoned', {
    orderId: 'order_ABANDON006',
    amountPaise: 349900,
    email: 'neha@example.com',
    phone: '+919810000006',
    name: 'Neha',
  });

  console.log('--- Simulating: Subscription pending then halted ---');
  await postWebhook(subscriptionEvent('subscription.pending', { subId: 'sub_007', phone: '+919810000007', email: 'karan@example.com', amountPaise: 199900 }));
  await postWebhook(subscriptionEvent('subscription.halted', { subId: 'sub_007', phone: '+919810000007', email: 'karan@example.com', amountPaise: 199900 }));

  console.log('--- Simulating: Same UPI failure retried twice more (to show retry cap -> escalate) ---');
  await postWebhook(
    paymentFailedEvent({
      orderId: 'order_UPI001',
      paymentId: 'pay_UPI001_retry1',
      amount: 149900,
      email: 'riya@example.com',
      phone: '+919810000001',
      name: 'Riya',
      errorCode: 'BAD_REQUEST_ERROR',
      errorReason: 'upi_declined',
      errorDescription: 'UPI transaction declined by NPCI',
      lang: 'hi',
    })
  );
  await postWebhook(
    paymentFailedEvent({
      orderId: 'order_UPI001',
      paymentId: 'pay_UPI001_retry2',
      amount: 149900,
      email: 'riya@example.com',
      phone: '+919810000001',
      name: 'Riya',
      errorCode: 'BAD_REQUEST_ERROR',
      errorReason: 'upi_declined',
      errorDescription: 'UPI transaction declined by NPCI',
      lang: 'hi',
    })
  );

  console.log('\n✅ Simulation complete. Open the dashboard to see results: http://localhost:3000/\n');
}

run().catch((e) => {
  console.error('Simulation failed:', e);
  process.exit(1);
});
