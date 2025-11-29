// backend/src/routes/historyPageRoutes.js

const express = require("express");
const router = express.Router();

// NOTE: path is from backend/src/routes/*
const Article = require("../models/Article");

// GET /api/history-page
// Returns all published articles that have a `year` (0–4000) and era = 'BC'
router.get("/", async (req, res) => {
  try {
    const sortParam = String(req.query.sort || "asc").toLowerCase();
    const sortOrder = sortParam === "desc" ? -1 : 1; // asc = 0 → 4000, desc = 4000 → 0

    // We purposely DO NOT rely on category name here.
    // Any article with a year + era 'BC' is treated as "history".
    const items = await Article.find({
      status: "published",
      era: "BC",
      year: { $gte: 0, $lte: 4000 },
    })
      .select("title slug summary imageUrl category year era publishedAt createdAt")
      .sort({ year: sortOrder, createdAt: sortOrder })
      .lean();

    return res.json({
      ok: true,
      sort: sortParam,
      total: items.length,
      items,
    });
  } catch (e) {
    console.error("[/api/history-page] failed:", e);
    return res.status(500).json({ ok: false, error: "Failed to load history timeline" });
  }
});

module.exports = router;
