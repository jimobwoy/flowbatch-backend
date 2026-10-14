'use strict';
const DAY = 86400000;

function dayKey(ms, offsetMin) {
  return new Date(ms + offsetMin * 60000).toISOString().slice(0, 10);
}
// Epoch-ms of local midnight for the day containing `ms`.
function startOfDay(ms, offsetMin) {
  const local = ms + offsetMin * 60000;
  return Math.floor(local / DAY) * DAY - offsetMin * 60000;
}
function startOfMonth(ms, offsetMin) {
  const d = new Date(ms + offsetMin * 60000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - offsetMin * 60000;
}
module.exports = { DAY, dayKey, startOfDay, startOfMonth };
