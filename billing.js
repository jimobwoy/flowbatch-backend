'use strict';
const { tx } = require('./db');
const { DAY } = require('./time');

// Idempotent: safe to call from BOTH the webhook and the browser callback.
// Returns { ok, reason?, alreadyProcessed?, userId?, periodEnd? }
function activatePayment(db, plans, { reference, amount, currency, paidAt }) {
  return tx(db, () => {
    const pay = db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
    if (!pay) return { ok: false, reason: 'unknown_reference' };
    if (pay.status === 'success') return { ok: true, alreadyProcessed: true, userId: pay.user_id, periodEnd: pay.period_end };
    if (pay.method !== 'paystack') return { ok: false, reason: 'not_a_paystack_payment' };

    // Never trust the amount in the request alone: it must match what WE asked for.
    if (Number(amount) !== pay.amount || String(currency).toUpperCase() !== pay.currency.toUpperCase()) {
      db.prepare("UPDATE payments SET status = 'failed', note = ? WHERE id = ?")
        .run(`amount/currency mismatch: got ${amount} ${currency}`, pay.id);
      return { ok: false, reason: 'amount_mismatch' };
    }
    const plan = plans.find((p) => p.id === pay.plan);
    if (!plan) return { ok: false, reason: 'unknown_plan' };

    const user = db.prepare('SELECT id, sub_end FROM users WHERE id = ?').get(pay.user_id);
    if (!user) return { ok: false, reason: 'unknown_user' };

    const now = Date.now();
    const start = Math.max(now, user.sub_end || 0); // renewing early stacks on top of remaining time
    const end = start + plan.days * DAY;
    db.prepare("UPDATE payments SET status = 'success', paid_at = ?, period_start = ?, period_end = ? WHERE id = ?")
      .run(paidAt || now, start, end, pay.id);
    db.prepare("UPDATE users SET sub_end = ?, sub_kind = 'paid' WHERE id = ?").run(end, user.id);
    return { ok: true, userId: user.id, periodEnd: end };
  });
}

module.exports = { activatePayment };
