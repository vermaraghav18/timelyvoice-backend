// backend/src/routes/automation/index.js
const express = require("express");
const router = express.Router();
const ctrl = require("../../controllers/automation.controller");

// ---------- Feeds ----------
router.get("/feeds", ctrl.getFeeds);
router.post("/feeds", ctrl.createFeed);
router.patch("/feeds/:id", ctrl.updateFeed);
router.delete("/feeds/:id", ctrl.deleteFeed);
router.post("/feeds/:id/fetch", ctrl.fetchFeed);

// ---------- Items ----------
router.get("/items", ctrl.listItems);
router.post("/items/:id/extract", ctrl.extractItem);
router.post("/items/:id/generate", ctrl.generateItem);
router.post("/items/:id/mark-ready", ctrl.markReady);
router.post("/items/:id/draft", ctrl.createDraft);

// ---------- X / Twitter automation ----------
router.use("/x", require("./x"));

// ---------- Global controls (Start / Stop / Run / Status) ----------
const { startAutmotion, stopAutmotion, runOnceNow, getStatus } = require("../../jobs/autmotion");

let requireAuthAdmin = (_req, _res, next) => next(); // fallback no-op
try {
  // Uncomment if you have admin middleware:
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
