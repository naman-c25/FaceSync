import { config } from '../config/index.js';

const API = 'https://api.razorpay.com/v1';

export class RazorpayError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'RazorpayError';
    this.status = status ?? null;
    this.code = code ?? null;
  }
}

function authHeader() {
  const pair = `${config.RAZORPAY_KEY_ID}:${config.RAZORPAY_KEY_SECRET}`;
  return `Basic ${Buffer.from(pair).toString('base64')}`;
}

async function call(method, path, body) {
  if (!config.paymentsEnabled) {
    throw new RazorpayError('Razorpay is not configured', { code: 'not_configured' });
  }

  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (cause) {
    throw new RazorpayError(
      cause.name === 'TimeoutError' ? 'Razorpay timed out' : 'Razorpay is unreachable',
      { code: 'unreachable' },
    );
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new RazorpayError(error.description ?? `Razorpay returned ${response.status}`, {
      status: response.status,
      code: error.code ?? null,
    });
  }

  return payload;
}

/**
 * Create an order for an authorised transaction.
 *
 * This is as far as a test-mode integration honestly reaches. Razorpay's
 * server-to-server payment endpoints are not enabled on a test account — they
 * return 404 — so there is no way to settle an order without the customer
 * interacting with a checkout on some device. Which is exactly the device this
 * whole system exists to do without.
 *
 * In production that gap is closed by a UPI Autopay mandate registered at
 * enrollment: the face match authorises a debit against a mandate the customer
 * already agreed to, with no device at the till. Setting one up needs merchant
 * KYC, so a prototype cannot demonstrate it — and pretending otherwise in a
 * demo is the kind of thing that falls apart under one question.
 *
 * The order created here is real, appears in the Razorpay dashboard, and is
 * what a mandate debit would be raised against.
 */
export async function createOrder({ amountPaise, merchantId, userId, receipt }) {
  return call('POST', '/orders', {
    amount: amountPaise,
    currency: 'INR',
    receipt: receipt.slice(0, 40), // Razorpay caps this
    notes: {
      merchant_id: merchantId,
      // The identity the face match resolved to, so an order can be traced
      // back to the attempt that authorised it.
      facepay_user: String(userId),
      authorised_by: 'facepay-biometric',
    },
  });
}

export async function fetchOrder(orderId) {
  return call('GET', `/orders/${orderId}`);
}
