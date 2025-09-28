// routes/analytics.js
const express = require('express');
const router = express.Router();

/**
 * Simple health check for analytics.
 * We'll expand this later to show counts, but for now it proves routing/CORS work.
 */
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'analytics',
    serverTime: new Date().toISOString(),
  });
});

/**
 * Stub for the collector (no storage yet).
 * Lets us test POST + CORS + JSON body.
 */
router.post('/collect', (req, res) => {
  const body = req.body || {};
  const events = Array.isArray(body.events) ? body.events.length : 0;

  return res.status(202).json({
    ok: true,
    receivedEvents: events,
    note: 'collector stub (no DB yet)',
  });
});

module.exports = router;
