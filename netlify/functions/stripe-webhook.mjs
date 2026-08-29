import Stripe from 'stripe';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './firebase-admin.mjs';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
if (!stripeSecretKey) throw new Error('STRIPE_SECRET_KEY is not configured.');
const stripe = new Stripe(stripeSecretKey);

const response = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

function rawBody(event) {
  return event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : Buffer.from(event.body || '', 'utf8');
}

async function fulfillCheckout(session) {
  const checkoutId = session.metadata?.aecorayCheckoutId || session.client_reference_id;
  if (!checkoutId) throw new Error('Stripe session is missing the Aecoray checkout ID.');

  const checkoutRef = adminDb.collection('CHECKOUTS').doc(checkoutId);
  const orderRef = adminDb.collection('ORDERS').doc(checkoutId);

  await adminDb.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (orderSnap.exists) return;

    const checkoutSnap = await tx.get(checkoutRef);
    if (!checkoutSnap.exists) throw new Error(`Checkout ${checkoutId} was not found.`);
    const checkout = checkoutSnap.data();

    const productRefs = checkout.items.map((item) => adminDb.collection('PRODUCTS').doc(item.productId));
    const productSnaps = await Promise.all(productRefs.map((ref) => tx.get(ref)));
    let stockIssue = false;

    checkout.items.forEach((item, index) => {
      const snap = productSnaps[index];
      if (!snap.exists) {
        stockIssue = true;
        return;
      }
      const product = snap.data();
      if (product.inventory === null || product.inventory === undefined) return;
      const current = Number(product.inventory);
      const quantity = Number(item.quantity || 1);
      if (!Number.isFinite(current) || current < quantity) {
        stockIssue = true;
        return;
      }
      tx.update(productRefs[index], {
        inventory: current - quantity,
        updatedAt: FieldValue.serverTimestamp()
      });
    });

    tx.set(orderRef, {
      buyerId: checkout.buyerId,
      buyerEmail: checkout.buyerEmail || session.customer_details?.email || '',
      sellerIds: checkout.sellerIds || [],
      items: checkout.items || [],
      currency: session.currency || checkout.currency || 'cad',
      amountTotalCents: session.amount_total ?? checkout.amountCents ?? null,
      stripeSessionId: session.id,
      stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || '',
      paymentStatus: session.payment_status || 'paid',
      orderStatus: 'new',
      stockIssue,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    tx.set(checkoutRef, {
      status: 'paid',
      stripeSessionId: session.id,
      paidAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return response(405, { error: 'Method not allowed.' });
  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET is not configured.');
    return response(500, { error: 'Webhook is not configured.' });
  }

  const signature = event.headers?.['stripe-signature'] || event.headers?.['Stripe-Signature'];
  if (!signature) return response(400, { error: 'Missing Stripe signature.' });

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody(event), signature, webhookSecret);
  } catch (error) {
    console.error('Stripe webhook signature verification failed', error.message);
    return response(400, { error: 'Invalid webhook signature.' });
  }

  try {
    if (stripeEvent.type === 'checkout.session.completed' || stripeEvent.type === 'checkout.session.async_payment_succeeded') {
      const session = stripeEvent.data.object;
      if (session.payment_status === 'paid' || stripeEvent.type === 'checkout.session.async_payment_succeeded') {
        await fulfillCheckout(session);
      }
    }
    return response(200, { received: true });
  } catch (error) {
    console.error('Stripe webhook processing failed', error);
    return response(500, { error: 'Webhook processing failed.' });
  }
}
