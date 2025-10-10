// backend/middleware/analyticsBotFilter.js
const jwt = require('jsonwebtoken');

// Basic bot UA check (safe list; can expand later)
const botRegex = /(bot|crawler|spider|google|bing|baidu|yandex|duckduck|facebook|pinterest|slurp)/i;

module.exports = function analyticsBotFilter() {
  return function (req, res, next) {
    const ua = req.headers['user-agent'] || '';

    // --- Flags (defaults) ---
    req.isBot = false;
    req.isAdmin = false;
    req.isDnt = false;
    req.isOptOut = false;

    // Bot detection
    if (botRegex.test(ua)) {
      req.isBot = true;
    }

    // Do-Not-Track (browser)
    if ((req.headers['dnt'] || '').toString() === '1') {
      req.isDnt = true;
    }

    // Opt-out (cookie or header; SDK later will set cookie)
    // Accepts cookie `analytics_optout=1` or header `x-analytics-optout: 1`
    const cookie = (req.headers['cookie'] || '').toLowerCase();
    if (cookie.includes('analytics_optout=1') || (req.headers['x-analytics-optout'] || '') === '1') {
      req.isOptOut = true;
    }

    // Admin detection (JWT in Authorization) — optional, best-effort
    // If JWT is present and decodes with { role:'admin' } or { isAdmin:true } we mark admin.
    try {
      const auth = req.headers['authorization'] || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const secret = process.env.JWT_SECRET;
      if (token && secret) {
        const dec = jwt.verify(token, secret);
        if (dec && (dec.role === 'admin' || dec.isAdmin === true)) {
          req.isAdmin = true;
        }
      }
    } catch (_) {
      // ignore JWT errors; non-admin by default
    }

    // Dev override to force non-bot for local testing
    // Send header: X-Force-NonBot: 1
    if ((req.headers['x-force-nonbot'] || '') === '1') {
      req.isBot = false;
    }

    // Attach a very simple device capture (UA passthrough)
    req.device = { ua };

    next();
  };
};
