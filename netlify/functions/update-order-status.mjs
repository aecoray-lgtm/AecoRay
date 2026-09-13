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

function cleanText(value, maxLength = 180) {
  return String(value || '').trim().slice(0, maxLength);
}

function cleanDate(value) {
  const raw = cleanText(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return response(405, { error: 'Method not allowed.' });
  }

  try {
    const authorization =
      event.headers?.authorization || event.headers?.Authorization;

    if (!authorization || !authorization.startsWith('Bearer ')) {
      return response(401, { error: 'Authentication required.' });
    }

    const idToken = authorization.slice(7);
    const decodedToken = await adminAuth.verifyIdToken(idToken);
    const sellerId = decodedToken.uid;

    const body = JSON.parse(event.body || '{}');
    const orderId = cleanText(body.orderId, 160);
    const newStatus = cleanText(body.status, 30).toLowerCase();

    if (!orderId) {
      return response(400, { error: 'Order ID is required.' });
    }

    if (!allowedStatuses.includes(newStatus)) {
      return response(400, { error: 'Invalid order status.' });
    }

    const orderRef = adminDb.collection('ORDERS').doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return response(404, { error: 'Order not found.' });
    }

    const order = orderSnap.data();
    const sellerIds = Array.isArray(order.sellerIds) ? order.sellerIds : [];

    if (!sellerIds.includes(sellerId)) {
      return response(403, {
        error: 'You are not authorized to update this order.'
      });
    }

    const sellerStatuses = order.sellerStatuses || {};
    const currentSellerData = sellerStatuses?.[sellerId] || {};
    const currentSellerStatus = currentSellerData.status || 'new';

    const statusOrder = {
      new: 0,
      processing: 1,
      shipped: 2,
      delivered: 3
    };

    const currentRank = statusOrder[currentSellerStatus] ?? 0;
    const newRank = statusOrder[newStatus];

    if (newRank < currentRank) {
      return response(400, {
        error: 'Order status cannot be moved backwards.'
      });
    }

    if (newRank > currentRank + 1) {
      return response(400, {
        error: 'Move the order through each fulfillment stage in sequence.'
      });
    }

    const updates = {
      [`sellerStatuses.${sellerId}.status`]: newStatus,
      [`sellerStatuses.${sellerId}.updatedAt`]: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };

    if (newStatus === 'processing' && !currentSellerData.processingAt) {
      updates[`sellerStatuses.${sellerId}.processingAt`] =
        FieldValue.serverTimestamp();

      const estimatedShipDate = cleanDate(body.estimatedShipDate);
      if (estimatedShipDate) {
        updates[`sellerStatuses.${sellerId}.estimatedShipDate`] =
          estimatedShipDate;
      }
    }

    if (newStatus === 'shipped' && !currentSellerData.shippedAt) {
      updates[`sellerStatuses.${sellerId}.shippedAt`] =
        FieldValue.serverTimestamp();

      const estimatedDeliveryDate = cleanDate(body.estimatedDeliveryDate);
      const carrier = cleanText(body.carrier, 100);
      const trackingNumber = cleanText(body.trackingNumber, 120);

      if (estimatedDeliveryDate) {
        updates[`sellerStatuses.${sellerId}.estimatedDeliveryDate`] =
          estimatedDeliveryDate;
      }
      if (carrier) {
        updates[`sellerStatuses.${sellerId}.carrier`] = carrier;
      }
      if (trackingNumber) {
        updates[`sellerStatuses.${sellerId}.trackingNumber`] =
          trackingNumber;
      }
    }

    if (newStatus === 'delivered' && !currentSellerData.deliveredAt) {
      updates[`sellerStatuses.${sellerId}.deliveredAt`] =
        FieldValue.serverTimestamp();
    }

    await orderRef.update(updates);

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
