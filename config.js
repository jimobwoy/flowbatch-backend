'use strict';
const crypto = require('node:crypto');

// Prices are in MINOR units (kobo for NGN: 500000 = ₦5,000). These are
// placeholders — set your real prices with the PLANS_JSON env var.
const DEFAULT_PLANS = [
  { id: 'monthly', name: 'Monthly', days: 30, amount: 500000 },
  { id: 'quarterly', name: '3 months', days: 90, amount: 1350000 },
  { id: 'yearly', name: 'Yearly', days: 365, amount: 4800000 }
];

function parsePlans(json) {
  if (!json) return DEFAULT_PLANS;
  let plans;
  try { plans = JSON.parse(json); } catch { throw new Error('PLANS_JSON is not valid JSON.'); }
  if (!Array.isArray(plans) || !plans.length) throw new Error('PLANS_JSON must be a non-empty array.');
  for (const p of plans) {
    if (!/^[a-z0-9_-]{1,32}$/i.test(p.id || '') || !(p.days > 0) || !(Number.isInteger(p.amount) && p.amount > 0) || !p.name) {
      throw new Error('Each plan needs id, name, days (>0) and amount (positive integer, minor units).');
    }
  }
  return plans;
}

function loadConfig(env = process.env) {
  const secret = env.JWT_SECRET || '';
  if (env.NODE_ENV === 'production' && secret.length < 32) {
    throw new Error('JWT_SECRET must be a random string of at least 32 characters in production.');
  }
  const trial = env.TRIAL_DAYS === undefined || env.TRIAL_DAYS === '' ? 3 : Number(env.TRIAL_DAYS);
  const tz = env.TZ_OFFSET_MINUTES === undefined || env.TZ_OFFSET_MINUTES === '' ? 60 : Number(env.TZ_OFFSET_MINUTES);
  return {
    port: Number(env.PORT) || 8787,
    dbPath: env.DATABASE_PATH || './data/app.db',
    jwtSecret: secret || crypto.randomBytes(32).toString('hex'),
    ephemeralSecret: !secret,
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    paystackSecret: env.PAYSTACK_SECRET_KEY || '',
    currency: env.CURRENCY || 'NGN',
    trialDays: Number.isFinite(trial) && trial >= 0 ? trial : 3,
    adminEmail: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
    adminPassword: env.ADMIN_PASSWORD || '',
    trustProxy: env.TRUST_PROXY === '1',
    tzOffsetMin: Number.isFinite(tz) ? tz : 60, // default Africa/Lagos = UTC+1
    onlineWindowSec: 150,
    plans: parsePlans(env.PLANS_JSON)
  };
}

module.exports = { loadConfig, DEFAULT_PLANS };
