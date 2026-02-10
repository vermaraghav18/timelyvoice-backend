// backend/src/routes/admin.aiNews.routes.js
// Admin AI News routes

const express = require("express");
const router = express.Router();

const slugify = require("slugify");
const Article = require("../models/Article");
const { generateNewsBatch } = require("../services/aiNewsGenerator");
const { finalizeArticleImages } = require("../services/finalizeArticleImages");
const AiGenerationLog = require("../models/AiGenerationLog");

// NEW: cron + RSS integration
const {
  getCronStatusSnapshot,
  runOnceAutoNews,
} = require("../cron/autoNewsCron");
const { fetchLiveSeeds } = require("../services/liveNewsIngestor");

// Use env-configured model for logging instead of hardcoding
const LOG_MODEL =
  process.env.OPENROUTER_MODEL_AUTONEWS ||
  process.env.OPENROUTER_MODEL ||
  "openai/gpt-4o-mini";

// ─────────────────────────────────────────────────────────────
// CRON SECRET PROTECTION
// This prevents random people on the internet from triggering AI generation.
// Render Cron Job will call with header: x-cron-secret: <AI_NEWS_CRON_SECRET>
// ─────────────────────────────────────────────────────────────
function requireCronSecret(req, res, next) {
  const secret = process.env.AI_NEWS_CRON_SECRET;

  // If secret not configured, fail closed (safer)
  if (!secret) {
    return res
      .status(500)
      .json({ ok: false, error: "Missing AI_NEWS_CRON_SECRET" });
  }

  const got = req.header("x-cron-secret");
  if (!got || got !== secret) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  return next();
}

// ─────────────────────────────────────────────────────────────
// Simple health check
// GET /api/admin/ai/ping
// ─────────────────────────────────────────────────────────────
router.get("/ping", (_req, res) => {
  res.json({ ok: true, scope: "admin-ai-news" });
});

// ─────────────────────────────────────────────────────────────
// CRON STATUS — used by AutomationDashboard "Automation status"
// GET /api/admin/ai/cron-status
// ─────────────────────────────────────────────────────────────
router.get("/cron-status", (_req, res) => {
  try {
    const snapshot = getCronStatusSnapshot();
    return res.json({ ok: true, status: snapshot });
  } catch (err) {
    console.error("[admin.aiNews] /cron-status error:", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "cron_status_failed",
    });
  }
});

// ─────────────────────────────────────────────────────────────
// MANUAL CRON RUN — trigger one AI automation cycle
// POST /api/admin/ai/run-cron-once
// Protected by x-cron-secret
// ─────────────────────────────────────────────────────────────
router.post("/run-cron-once", requireCronSecret, async (_req, res) => {
  try {
    const result = await runOnceAutoNews({ reason: "manual-api" });
    return res.json({
      ok: true,
      result,
    });
  } catch (err) {
    console.error("[admin.aiNews] /run-cron-once error:", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "cron_run_failed",
    });
  }
});

// ─────────────────────────────────────────────────────────────
// RSS SEEDS PREVIEW — debug what cron sees
// GET /api/admin/ai/rss-preview?limit=10
// Protected by x-cron-secret (recommended)
// ─────────────────────────────────────────────────────────────
router.get("/rss-preview", requireCronSecret, async (req, res) => {
  try {
    const limit = Math.max(
      1,
      Math.min(parseInt(req.query.limit || "10", 10), 50)
    );
    const seeds = await fetchLiveSeeds(limit);
    return res.json({
      ok: true,
      count: seeds.length,
      seeds,
    });
  } catch (err) {
    console.error("[admin.aiNews] /rss-preview error:", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "rss_preview_failed",
    });
  }
});

// ─────────────────────────────────────────────────────────────
// LOG LIST — for admin dashboard
// GET /api/admin/ai/logs?limit=50
// (not protected; contains no secrets, OK to keep open if you want)
// ─────────────────────────────────────────────────────────────
router.get("/logs", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);

    const logs = await AiGenerationLog.find({})
      .sort({ runAt: -1 })
      .limit(limit)
      .lean();

    return res.json({
      ok: true,
      count: logs.length,
      logs,
    });
  } catch (err) {
    console.error("[admin.aiNews] /logs error:", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "ai_logs_failed",
    });
  }
});

// ─────────────────────────────────────────────────────────────
// PREVIEW ONLY — NO DB WRITE
// POST /api/admin/ai/preview-batch
// Protected by x-cron-secret (prevents AI cost abuse)
// ─────────────────────────────────────────────────────────────
router.post("/preview-batch", requireCronSecret, async (req, res) => {
  try {
    const { count, categories } = req.body || {};

    const { normalized } = await generateNewsBatch({
      count,
      categories,
    });

    return res.json({
      ok: true,
      mode: "preview",
      count: normalized.length,
      articles: normalized,
    });
  } catch (err) {
    console.error("[admin.aiNews] /preview-batch error:", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "ai_generation_failed",
    });
  }
});

// ─────────────────────────────────────────────────────────────
// SAVE TO DB — CREATES REAL Article DOCUMENTS + AUTO IMAGES
// POST /api/admin/ai/generate-batch
//
// Protected by x-cron-secret (prevents AI cost abuse)
//
// Body:
// {
//   "count": 5,                          // optional, default 10 (max 20)
//   "categories": ["World","Business"],  // optional
//   "status": "draft" | "published"      // optional, default "draft"
// }
// ─────────────────────────────────────────────────────────────
router.post("/generate-batch", requireCronSecret, async (req, res) => {
  const startedAt = Date.now();

  const { count, categories, status } = req.body || {};
  const desiredStatus = (status || "draft").toLowerCase();

  let normalized = [];
  const createdSummaries = [];

  try {
    const result = await generateNewsBatch({
      count,
      categories,
    });
    normalized = result.normalized || [];

    if (!normalized.length) {
      // Log: nothing generated
      await AiGenerationLog.create({
        runAt: new Date(startedAt),
        model: LOG_MODEL,
        countRequested: count || null,
        countGenerated: 0,
        countSaved: 0,
        status: "error",
        errorMessage: "no_articles_generated",
        durationMs: Date.now() - startedAt,
        requestStatus: desiredStatus,
        categories: Array.isArray(categories) ? categories : [],
      });

      return res.json({
        ok: false,
        error: "no_articles_generated",
        count: 0,
      });
    }

    // Actually create Article docs one by one
    for (const g of normalized) {
      // Base slug from AI output, or from title
      let baseSlug =
        g.slug ||
        slugify(g.title || "article", { lower: true, strict: true }) ||
        `article-${Date.now()}`;

      const payload = {
        title: g.title,
        slug: baseSlug,
        summary: g.summary || "",
        author: g.author || "Desk",
        category: g.category || "General",
        status: "draft", // override later
        publishAt: g.publishAt || new Date(),
        imageUrl: g.imageUrl || null,
        imagePublicId: g.imagePublicId || null,
        imageAlt: g.imageAlt || g.title || "",
        metaTitle: (g.metaTitle || g.title || "").slice(0, 80),
        metaDesc: (g.metaDesc || g.summary || "").slice(0, 200),
        ogImage: g.ogImage || null,
        geoMode: g.geoMode || "global",
        geoAreas: Array.isArray(g.geoAreas) ? g.geoAreas : [],
        tags: Array.isArray(g.tags) ? g.tags : [],
        body: g.body || "",
        source: "ai-batch",
        sourceUrl: g.sourceUrl || "",
      };

      // 🔁 FINALIZE IMAGES (Drive → Cloudinary + OG + thumb)
      // eslint-disable-next-line no-await-in-loop
      const fin = await finalizeArticleImages({
        title: payload.title,
        summary: payload.summary,
        category: payload.category,
        tags: payload.tags,
        slug: payload.slug,
        imageUrl: payload.imageUrl,
        imagePublicId: payload.imagePublicId,
        imageAlt: payload.imageAlt,
        ogImage: payload.ogImage,
        thumbImage: null,
      });

      if (fin) {
        payload.imagePublicId = fin.imagePublicId;
        payload.imageUrl = fin.imageUrl;
        payload.ogImage = fin.ogImage;
        payload.thumbImage = fin.thumbImage;
        payload.imageAlt = payload.imageAlt || fin.imageAlt;
      }

      // Ensure slug is unique
      let finalSlug = payload.slug;
      let suffix = 2;
      // eslint-disable-next-line no-await-in-loop
      while (await Article.exists({ slug: finalSlug })) {
        finalSlug = `${payload.slug}-${suffix++}`;
      }
      payload.slug = finalSlug;

      // Final status + timestamps
      payload.status = desiredStatus === "published" ? "published" : "draft";
      if (payload.status === "published") {
        payload.publishedAt = new Date();
      }

      // eslint-disable-next-line no-await-in-loop
      const doc = await Article.create(payload);

      createdSummaries.push({
        articleId: doc._id,
        slug: doc.slug,
        title: doc.title,
        status: doc.status,
        publishAt: doc.publishAt,
      });
    }

    // Log success
    await AiGenerationLog.create({
      runAt: new Date(startedAt),
      model: LOG_MODEL,
      countRequested: count || null,
      countGenerated: normalized.length,
      countSaved: createdSummaries.length,
      status: "success",
      durationMs: Date.now() - startedAt,
      requestStatus: desiredStatus,
      categories: Array.isArray(categories) ? categories : [],
      samples: createdSummaries,
      triggeredBy: "api-admin-ai-generate-batch",
    });

    return res.json({
      ok: true,
      mode: "saved",
      created: createdSummaries.length,
      articles: createdSummaries,
    });
  } catch (err) {
    console.error("[admin.aiNews] /generate-batch error:", err?.message || err);

    // Log error
    try {
      await AiGenerationLog.create({
        runAt: new Date(startedAt),
        model: LOG_MODEL,
        countRequested: count || null,
        countGenerated: normalized.length || 0,
        countSaved: createdSummaries.length || 0,
        status: "error",
        errorMessage: err?.message || String(err),
        durationMs: Date.now() - startedAt,
        requestStatus: desiredStatus,
        categories: Array.isArray(categories) ? categories : [],
        samples: createdSummaries,
        triggeredBy: "api-admin-ai-generate-batch",
      });
    } catch (logErr) {
      console.error("[admin.aiNews] log-create failed:", logErr?.message || logErr);
    }

    return res.status(500).json({
      ok: false,
      error: err?.message || "ai_generate_save_failed",
    });
  }
});

module.exports = router;
