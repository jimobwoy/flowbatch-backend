'use strict';
const crypto = require('node:crypto');

function createPaystack(secretKey, fetchImpl = fetch) {
  const base = 'https://api.paystack.co';
  async function call(method, path, body) {
    const res = await fetchImpl(base + path, {
      method,
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status === false) throw new Error(data.message || `Paystack error ${res.status}`);
    return data.data;
  }
  return {
    configured: Boolean(secretKey),
    initialize: (payload) => call('POST', '/transaction/initialize', payload),
    verify: (reference) => call('GET', `/transaction/verify/${encodeURIComponent(reference)}`)
  };
}

// Paystack signs the RAW request body with your secret key (HMAC-SHA512) and
// sends it in the x-paystack-signature header.
function verifyWebhookSignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  const expected = Buffer.from(crypto.createHmac('sha512', secret).update(rawBody).digest('hex'));
  const given = Buffer.from(String(signature));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { createPaystack, verifyWebhookSignature };
