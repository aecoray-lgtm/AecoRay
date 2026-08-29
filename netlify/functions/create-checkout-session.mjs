import Stripe from 'stripe';
import { FieldValue } from 'firebase-admin/firestore';
import { adminAuth, adminDb } from './firebase-admin.mjs';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
if (!stripeSecretKey) throw new Error('STRIPE_SECRET_KEY is not configured.');
const stripe = new Stripe(stripeSecretKey);

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

function getBearerToken(headers = {}) {
  const value = headers.authorization || headers.Authorization || '';
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

function safeOrigin(event) {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (origin && /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin)) return origin;
  return 'https://www.aecoray.com';
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });

  try {
    const token = getBearerToken(event.headers);
    if (!token) return json(401, { error: 'Please log in before checking out.' });

    const decoded = await adminAuth.verifyIdToken(token);
    const body = JSON.parse(event.body || '{}');
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (!rawItems.length) return json(400, { error: 'Your cart is empty.' });
    if (rawItems.length > 50) return json(400, { error: 'Too many cart items.' });

    const quantities = new Map();
    for (const item of rawItems) {
      const productId = String(item?.productId || '').trim();
      if (!productId) return json(400, { error: 'A cart item is missing its product ID.' });
      quantities.set(productId, (quantities.get(productId) || 0) + 1);
    }

    const productEntries = [];
    for (const [productId, quantity] of quantities.entries()) {
      const snap = await adminDb.collection('PRODUCTS').doc(productId).get();
      if (!snap.exists) return json(400, { error: 'A product in your cart is no longer available.' });

      const product = snap.data();
      const price = Number(product.price);
      const inventory = product.inventory;
      const status = product.status || 'active';

      if (status === 'draft') return json(400, { error: `${product.name || 'A product'} is not currently published.` });
      if (!Number.isFinite(price) || price <= 0) return json(400, { error: `${product.name || 'A product'} has an invalid price.` });
      if (!product.sellerId) return json(400, { error: `${product.name || 'A product'} is missing seller information.` });
      if (inventory !== null && inventory !== undefined) {
        const available = Number(inventory);
        if (!Number.isFinite(available) || available < quantity) {
          return json(400, { error: `${product.name || 'A product'} does not have enough stock.` });
        }
      }

      productEntries.push({ productId, quantity, product, price });
    }

    const checkoutRef = adminDb.collection('CHECKOUTS').doc();
    const origin = safeOrigin(event);
    const sellerIds = [...new Set(productEntries.map(({ product }) => product.sellerId))];
    const amountCents = productEntries.reduce((sum, { price, quantity }) => sum + Math.round(price * 100) * quantity, 0);

    await checkoutRef.set({
      buyerId: decoded.uid,
      buyerEmail: decoded.email || '',
      sellerIds,
      amountCents,
      currency: 'cad',
      status: 'creating',
      items: productEntries.map(({ productId, quantity, product, price }) => ({
        productId,
        quantity,
        sellerId: product.sellerId,
        sellerName: product.sellerName || '',
        businessName: product.businessName || '',
        name: product.name || 'Marketplace item',
        unitAmountCents: Math.round(price * 100),
        fulfillment: product.fulfillment || 'shipping',
        imageUrl: product.imageUrl || ''
      })),
      createdAt: FieldValue.serverTimestamp()
    });

    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        client_reference_id: checkoutRef.id,
        customer_email: decoded.email || undefined,
        line_items: productEntries.map(({ product, price, quantity }) => ({
          quantity,
          price_data: {
            currency: 'cad',
            unit_amount: Math.round(price * 100),
            product_data: {
              name: String(product.name || 'Aecoray marketplace item').slice(0, 127),
              description: String(product.description || '').slice(0, 500) || undefined,
              images: /^https:\/\//i.test(product.imageUrl || '') ? [product.imageUrl] : undefined
            }
          }
        })),
        metadata: {
          aecorayCheckoutId: checkoutRef.id,
          buyerId: decoded.uid
        },
        success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/?checkout=cancelled`
      });
    } catch (error) {
      await checkoutRef.set({ status: 'stripe_error', error: String(error.message || error), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      throw error;
    }

    await checkoutRef.set({
      status: 'open',
      stripeSessionId: session.id,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    return json(200, { url: session.url });
  } catch (error) {
    console.error('create-checkout-session failed', error);
    return json(500, { error: 'Secure checkout could not be started. Please try again.' });
  }
}
