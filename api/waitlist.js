'use strict';

/* ============================================================
 * Retired endpoint.
 * The Road Crew email signup was removed from Weekend Road Trip in October
 * 2026. This handler remains only so old links fail cleanly: it stores
 * nothing, reads nothing, and never opens a database connection.
 * Safe to delete, together with waitlist.html, launch.js,
 * qa/waitlist-contract.js, qa/waitlist-stress.js and qa/launch-contract.js.
 * ============================================================ */

module.exports = function handler(req, res) {
  const body = { ok: false, error: 'The Road Crew signup has been retired. Nothing was saved.' };
  if (typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
  }
  if (typeof res.status === 'function') return res.status(410).json(body);
  res.statusCode = 410;
  return res.end(JSON.stringify(body));
};
