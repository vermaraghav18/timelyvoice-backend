"use strict";

const express = require("express");
const jwt = require("jsonwebtoken");
const XSource = require("../../models/XSource");
const XItem = require("../../models/XItem");
const { fetchUserTimeline } = require("../../services/x.fetch");

const router = express.Router();

/* -------------------- Auth (admin JWT) -------------------- */
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "dev_secret");
    if (decoded.role !== "admin") throw new Error("not admin");
    req.user = { role: "admin" };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

function cleanHandle(h = "") {
  return String(h).replace(/^@/, "").trim().toLowerCase();
}

/* =====================  SOURCES CRUD  ===================== */

// GET /api/automation/x/sources
router.get("/sources", requireAdmin, async (_req, res) => {
  const list = await XSource.find().sort({ createdAt: -1 }).lean();
  res.json(list);
});

// POST /api/automation/x/sources
router.post("/sources", requireAdmin, async (req, res) => {
  const { handle, label, enabled, defaultAuthor, defaultCategory } = req.body || {};
  const h = cleanHandle(handle);
  if (!h) return res.status(400).json({ error: "handle required" });

  const doc = await XSource.findOneAndUpdate(
    { handle: h },
    {
      $setOnInsert: { handle: h },
      $set: {
        label: label || "",
        enabled: enabled !== false,
        defaultAuthor: defaultAuthor || "Desk",
        defaultCategory: defaultCategory || "General",
      },
    },
    { new: true, upsert: true }
  );
  res.status(201).json(doc);
});

// PATCH /api/automation/x/sources/:id
router.patch("/sources/:id", requireAdmin, async (req, res) => {
  const update = {};
  if ("handle" in req.body) update.handle = cleanHandle(req.body.handle);
  if ("label" in req.body) update.label = String(req.body.label || "");
  if ("enabled" in req.body) update.enabled = !!req.body.enabled;
  if ("defaultAuthor" in req.body) update.defaultAuthor = String(req.body.defaultAuthor || "Desk");
  if ("defaultCategory" in req.body) update.defaultCategory = String(req.body.defaultCategory || "General");

  const doc = await XSource.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!doc) return res.status(404).json({ error: "not found" });
  res.json(doc);
});

// DELETE /api/automation/x/sources/:id
router.delete("/sources/:id", requireAdmin, async (req, res) => {
  const r = await XSource.deleteOne({ _id: req.params.id });
  res.json({ ok: true, deleted: r.deletedCount || 0 });
});

/* =====================  FETCH (token-less in your old code)  ===================== */
/* We keep them protected by admin token now for consistency.
   If you truly want public access, remove "requireAdmin" from these two. */

// POST /api/automation/x/sources/:id/fetch
router.post("/sources/:id/fetch", requireAdmin, async (req, res) => {
  try {
    const src = await XSource.findById(req.params.id).lean();
    if (!src) return res.status(404).json({ ok: false, error: "Source not found" });
    if (src.enabled === false) return res.json({ ok: true, inserted: 0, skipped: "disabled" });

    const handle = cleanHandle(src.handle);
    if (!handle) return res.status(400).json({ ok: false, error: "Invalid handle" });

    const items = await fetchUserTimeline({ handle, limit: 50 });
    let inserted = 0;

    for (const it of items) {
      const exists = await XItem.findOne({ xId: it.xId }).lean();
      if (exists) continue;
      await XItem.create({
        handle: it.handle,
        xId: it.xId,
        text: it.text,
        tweetedAt: it.tweetedAt || new Date().toISOString(),
        urls: it.urls || [],
        media: it.media || [],
        status: "new",
      });
      inserted++;
    }
    return res.json({ ok: true, inserted });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "fetch failed" });
  }
});

// POST /api/automation/x/sources/fetch-all
router.post("/sources/fetch-all", requireAdmin, async (_req, res) => {
  try {
    const sources = await XSource.find({ enabled: true }).lean();
    const results = [];
    let total = 0;

    for (const src of sources) {
      const handle = cleanHandle(src.handle);
      try {
        const items = await fetchUserTimeline({ handle, limit: 50 });
        let inserted = 0;
        for (const it of items) {
          const exists = await XItem.findOne({ xId: it.xId }).lean();
          if (exists) continue;
          await XItem.create({
            handle: it.handle,
            xId: it.xId,
            text: it.text,
            tweetedAt: it.tweetedAt || new Date().toISOString(),
            urls: it.urls || [],
            media: it.media || [],
            status: "new",
          });
          inserted++;
        }
        total += inserted;
        results.push({ id: String(src._id), handle, inserted });
      } catch (e) {
        results.push({ id: String(src._id), handle, error: e.message });
      }
    }
    return res.json({ ok: true, processed: sources.length, inserted: total, results });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "fetch-all failed" });
  }
});

module.exports = router;
