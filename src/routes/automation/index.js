// routes/automation/index.js
const express = require('express');
const ctrl = require('../../controllers/automation.controller');


const router = express.Router();

// Feeds
router.get('/feeds', ctrl.getFeeds);
router.post('/feeds', ctrl.createFeed);
router.patch('/feeds/:id', ctrl.updateFeed);
router.delete('/feeds/:id', ctrl.deleteFeed);
router.post('/feeds/:id/fetch', ctrl.fetchFeed);

// Items
router.get('/items', ctrl.listItems);
router.post('/items/:id/extract', ctrl.extractItem);
router.post('/items/:id/generate', ctrl.generateItem);
router.post('/items/:id/mark-ready', ctrl.markReady);
router.post('/items/:id/draft', ctrl.createDraft);

// X/Twitter automation
router.use('/x', require('./x'));


// === Global controls: Start / Stop / Status / Run Now ===
const { startAutmotion, stopAutmotion, runOnceNow, getStatus } = require("../../jobs/autmotion");

// NOTE: Use your existing admin auth middleware here.
// If you have `auth` in your index.js, import something like requireAuthAdmin:
let requireAuthAdmin = (_req, _res, next) => next(); // fallback no-op if missing
try {
  // If your project exposes admin auth middleware elsewhere, require it here.
  // Example:
  // const { requireAuthAdmin: r } = require("../../middleware/auth");
  // requireAuthAdmin = r;
} catch (_) {}

router.get("/status", requireAuthAdmin, (req, res) => {
  res.json(getStatus());
});

router.post("/control/start", requireAuthAdmin, (req, res) => {
  const sec = req.body?.intervalSec;
  startAutmotion(sec);
  res.json({ ok: true, ...getStatus() });
});

router.post("/control/stop", requireAuthAdmin, (req, res) => {
  stopAutmotion();
  res.json({ ok: true, ...getStatus() });
});

router.post("/control/run-now", requireAuthAdmin, async (req, res) => {
  await runOnceNow();
  res.json({ ok: true, ...getStatus() });
});

module.exports = router;
