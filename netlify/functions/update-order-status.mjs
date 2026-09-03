import { FieldValue } from 'firebase-admin/firestore';
import { adminAuth, adminDb } from './firebase-admin.mjs';

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  },
  body: JSON.stringify(body)
});

const allowedStatuses = ['new', 'processing', 'shipped', 'delivered'];

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return response(405, { error: 'Method not allowed.' });
  }

  try {
    // 1. Verify the logged-in Firebase user.
    const authorization =
      event.headers?.authorization || event.headers?.Authorization;

    if (!authorization || !authorization.startsWith('Bearer ')) {
      return response(401, { error: 'Authentication required.' });
    }

    const idToken = authorization.slice(7);
    const decodedToken = await adminAuth.verifyIdToken(idToken);
    const sellerId = decodedToken.uid;

    // 2. Read the order ID and requested status.
    const body = JSON.parse(event.body || '{}');
    const orderId = String(body.orderId || '').trim();
    const newStatus = String(body.status || '').trim().toLowerCase();

    if (!orderId) {
      return response(400, { error: 'Order ID is required.' });
    }

    if (!allowedStatuses.includes(newStatus)) {
      return response(400, { error: 'Invalid order status.' });
    }

    // 3. Load the trusted order from Firestore.
    const orderRef = adminDb.collection('ORDERS').doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return response(404, { error: 'Order not found.' });
    }

    const order = orderSnap.data();
    const sellerIds = Array.isArray(order.sellerIds)
      ? order.sellerIds
      : [];

    // 4. Confirm this seller actually belongs to this order.
    if (!sellerIds.includes(sellerId)) {
      return response(403, {
        error: 'You are not authorized to update this order.'
      });
    }

    // 5. Get THIS seller's current fulfillment status.
    const sellerStatuses = order.sellerStatuses || {};
    const currentSellerStatus =
      sellerStatuses?.[sellerId]?.status || 'new';

    const statusOrder = {
      new: 0,
      processing: 1,
      shipped: 2,
      delivered: 3
    };

    // Prevent this seller from moving their fulfillment backwards.
    if (
      statusOrder[currentSellerStatus] !== undefined &&
      statusOrder[newStatus] < statusOrder[currentSellerStatus]
    ) {
      return response(400, {
        error: 'Order status cannot be moved backwards.'
      });
    }

    // 6. Update ONLY this seller's fulfillment status.
    await orderRef.update({
      [`sellerStatuses.${sellerId}.status`]: newStatus,
      [`sellerStatuses.${sellerId}.updatedAt`]:
        FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    return response(200, {
      success: true,
      orderId,
      sellerId,
      status: newStatus
    });

  } catch (error) {
    console.error('Seller order status update failed:', error);

    return response(500, {
      error: 'Order status could not be updated.'
    });
  }
}
