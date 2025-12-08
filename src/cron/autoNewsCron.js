// backend/src/cron/autoNewsCron.js
"use strict";

/**
 * Auto Newsroom Cron
 * ------------------
 * Periodically calls the AI news generator and saves articles to MongoDB.
 */

const Article = require("../models/Article");
const AiGenerationLog = require("../models/AiGenerationLog");
const { generateNewsBatch } = require("../services/aiNewsGenerator");
const { finalizeArticleImages } = require("../services/finalizeArticleImages");
const { shouldSkipAsDuplicate } = require("../services/aiArticleGuard");
const slugify = require("slugify");
const { fetchLiveSeeds } = require("../services/liveNewsIngestor");

// NEW: topic-fingerprint deduper (backed by Mongo TTL)
const { computeTopicKey } = require("../services/rssDeduper");
const RssTopicFingerprint = require("../models/RssTopicFingerprint");

const AUTOMATION_MODEL = "openai/gpt-4o-mini";

const DEFAULT_INTERVAL_SEC = parseInt(
  process.env.AI_NEWS_CRON_INTERVAL_SECONDS || "300",
  10
);
const MAX_PER_RUN = parseInt(
  process.env.AI_NEWS_CRON_MAX_PER_RUN || "1",
  10
);
const MAX_PER_HOUR = parseInt(
  process.env.AI_NEWS_CRON_MAX_PER_HOUR || "12",
  10
);
const MAX_PER_DAY = parseInt(
  process.env.AI_NEWS_CRON_MAX_PER_DAY || "250",
  10
);

const DEFAULT_STATUS = String(
  process.env.AI_NEWS_CRON_STATUS || "draft"
).toLowerCase();

const FORCED_CATEGORIES = String(
  process.env.AI_NEWS_CRON_CATEGORIES || ""
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const WINDOW_START_HOUR = parseInt(
  process.env.AI_NEWS_CRON_WINDOW_START_HOUR || "0",
  10
);
const WINDOW_END_HOUR = parseInt(
  process.env.AI_NEWS_CRON_WINDOW_END_HOUR || "24",
  10
);

// in-memory guard + status snapshot
let timer = null;
let inFlight = false;

let lastRunAt = null;
let lastStatus = null;
let todayCountSaved = 0;
let todayDateKey = null;

function clampCount(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  return Math.floor(n);
}

function currentDateKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function isWithinTimeWindow(now = new Date()) {
  const h = now.getHours();
  if (WINDOW_START_HOUR === WINDOW_END_HOUR) return true;
  if (WINDOW_START_HOUR < WINDOW_END_HOUR) {
    return h >= WINDOW_START_HOUR && h < WINDOW_END_HOUR;
  }
  return h >= WINDOW_START_HOUR || h < WINDOW_END_HOUR;
}

async function computeAllowedCount() {
  const now = new Date();

  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);

  const [hourAgg, dayAgg] = await Promise.all([
    AiGenerationLog.aggregate([
      {
        $match: {
          triggeredBy: "cron-auto-newsroom",
          runAt: { $gte: oneHourAgo },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$countSaved" },
        },
      },
    ]),
    AiGenerationLog.aggregate([
      {
        $match: {
          triggeredBy: "cron-auto-newsroom",
          runAt: { $gte: dayStart },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$countSaved" },
        },
      },
    ]),
  ]);

  const usedHour = hourAgg?.[0]?.total || 0;
  const usedDay = dayAgg?.[0]?.total || 0;

  const leftHour = Math.max(0, MAX_PER_HOUR - usedHour);
  const leftDay = Math.max(0, MAX_PER_DAY - usedDay);

  const base = Math.min(MAX_PER_RUN, leftHour, leftDay);

  const allowed = clampCount(base);
  return {
    allowed,
    usedHour,
    usedDay,
  };
}

async function runOnceAutoNews({ reason = "interval" } = {}) {
  if (inFlight) {
    console.log("[autoNewsCron] skip — previous run still in flight");
    return;
  }

  const now = new Date();

  if (!isWithinTimeWindow(now)) {
    console.log(
      "[autoNewsCron] outside time window %s-%s (h=%s) — skipping",
      WINDOW_START_HOUR,
      WINDOW_END_HOUR,
      now.getHours()
    );
    return;
  }

  const startedAt = Date.now();
  inFlight = true;

  const key = currentDateKey(now);
  if (todayDateKey !== key) {
    todayDateKey = key;
    todayCountSaved = 0;
  }

  try {
    const { allowed, usedHour, usedDay } = await computeAllowedCount();

    if (!allowed) {
      console.log(
        "[autoNewsCron] no allowance left (usedHour=%s, usedDay=%s) — skipping",
        usedHour,
        usedDay
      );
      lastRunAt = new Date();
      lastStatus = "success";
      return;
    }

    const desiredStatus =
      DEFAULT_STATUS === "published" ? "published" : "draft";

    const categories =
      FORCED_CATEGORIES && FORCED_CATEGORIES.length
        ? FORCED_CATEGORIES
        : undefined;

    console.log(
      "[autoNewsCron] running (%s) allowed=%s status=%s categories=%s",
      reason,
      allowed,
      desiredStatus,
      categories ? categories.join(",") : "(auto)"
    );

    const createdSummaries = [];
    let skippedDuplicates = 0;
    let skippedTopicDuplicates = 0;

    const pickedCategory =
      FORCED_CATEGORIES.length > 0
        ? FORCED_CATEGORIES[
            Math.floor(Math.random() * FORCED_CATEGORIES.length)
          ]
        : undefined;

       // 1) Pull fresh live seeds from RSS
    //    This uses your FEEDS array and drops anything older than 24h or wrong year
    const seedLimit = Math.max(allowed * 3, 10); // pool a few extra, it’s cheap
    let seeds = [];
    try {
      seeds = await fetchLiveSeeds(seedLimit);
    } catch (e) {
      console.error("[autoNewsCron] fetchLiveSeeds error:", e);
      seeds = [];
    }

    if (!seeds || !seeds.length) {
      console.warn(
        "[autoNewsCron] No fresh RSS seeds found; falling back to generic aiNewsGenerator prompt."
      );
    }

    const result = await generateNewsBatch({
      count: allowed,
      categories: pickedCategory ? [pickedCategory] : categories,
      trendingBias: true,
      mode: "standard",
      seeds, // <-- NEW: pass RSS seeds into generator
    });


    const normalized = result?.normalized || [];

    if (!normalized.length) {
      console.warn("[autoNewsCron] generator returned 0 articles");

      await AiGenerationLog.create({
        runAt: new Date(startedAt),
        model: AUTOMATION_MODEL,
        countRequested: allowed,
        countGenerated: 0,
        countSaved: 0,
        status: "error",
        errorMessage: "no_articles_generated",
        durationMs: Date.now() - startedAt,
        requestStatus: desiredStatus,
        categories: categories || [],
        samples: [],
        triggeredBy: "cron-auto-newsroom",
      });

      lastRunAt = new Date();
      lastStatus = "error";
      return;
    }

    // Create Article docs one by one
    for (const g of normalized) {
      let skipByTopicFingerprint = false;

      try {
        if (g.title) {
          const topicKey = computeTopicKey(g.title, g.sourceUrl || "");

          if (topicKey) {
            // eslint-disable-next-line no-await-in-loop
            const existingTopic =
              await RssTopicFingerprint.findOneAndUpdate(
                { topicKey },
                {
                  $setOnInsert: {
                    topicKey,
                    firstSeenAt: new Date(),
                  },
                  $set: {
                    latestTitle: g.title,
                    latestLink: g.sourceUrl || "",
                    lastSeenAt: new Date(),
                  },
                },
                { new: false, upsert: true }
              ).lean();

            if (existingTopic) {
              skippedTopicDuplicates += 1;
              skipByTopicFingerprint = true;
              console.log(
                "[autoNewsCron] skipping by topic fingerprint title=%s topicKey=%s",
                g.title,
                topicKey
              );
            }
          }
        }
      } catch (topicErr) {
        console.error(
          "[autoNewsCron] topic fingerprint check failed for title=%s err=%s",
          g.title,
          topicErr?.message || topicErr
        );
      }

      if (skipByTopicFingerprint) {
        continue;
      }

      // DB-level duplicate guard
      // eslint-disable-next-line no-await-in-loop
      const dup = await shouldSkipAsDuplicate({ title: g.title });
      if (dup.skip) {
        skippedDuplicates += 1;
        console.log(
          "[autoNewsCron] skipping duplicate article title=%s matchedSlug=%s score=%s",
          g.title,
          dup.matched?.slug || "(unknown)",
          dup.score != null ? dup.score.toFixed(2) : "n/a"
        );
        continue;
      }

      let baseSlug =
        g.slug ||
        slugify(g.title || "article", {
          lower: true,
          strict: true,
        }) ||
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

      // Finalize images
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
      });

      if (fin) {
        payload.imageUrl = fin.imageUrl || payload.imageUrl;
        payload.imagePublicId = fin.imagePublicId || payload.imagePublicId;
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
      payload.status =
        desiredStatus === "published" ? "published" : "draft";
      if (payload.status === "published") {
        payload.publishedAt = new Date();
      }

      // NEW: explicit timestamps so cron-created docs sort correctly
      const nowStamp = new Date();
      payload.createdAt = nowStamp;
      payload.updatedAt = nowStamp;

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

    await AiGenerationLog.create({
      runAt: new Date(startedAt),
      model: AUTOMATION_MODEL,
      countRequested: allowed,
      countGenerated: normalized.length,
      countSaved: createdSummaries.length,
      status: "success",
      durationMs: Date.now() - startedAt,
      requestStatus: desiredStatus,
      categories: categories || [],
      samples: createdSummaries,
      triggeredBy: "cron-auto-newsroom",
    });

    lastRunAt = new Date();
    lastStatus = "success";
    todayCountSaved += createdSummaries.length;

    console.log(
      "[autoNewsCron] done — saved=%s (requested=%s, generated=%s, skippedDuplicates=%s, skippedTopicDuplicates=%s)",
      createdSummaries.length,
      allowed,
      normalized.length,
      skippedDuplicates,
      skippedTopicDuplicates
    );
  } catch (err) {
    console.error("[autoNewsCron] run failed:", err?.message || err);

    try {
      await AiGenerationLog.create({
        runAt: new Date(),
        model: AUTOMATION_MODEL,
        countRequested: null,
        countGenerated: 0,
        countSaved: 0,
        status: "error",
        errorMessage: err?.message || String(err),
        durationMs: Date.now() - startedAt,
        requestStatus: DEFAULT_STATUS,
        categories: FORCED_CATEGORIES || [],
        samples: [],
        triggeredBy: "cron-auto-newsroom",
      });
    } catch (logErr) {
      console.error(
        "[autoNewsCron] log-create failed:",
        logErr?.message || logErr
      );
    }

    lastRunAt = new Date();
    lastStatus = "error";
  } finally {
    inFlight = false;
  }
}

function startAutoNewsCron(intervalSec = DEFAULT_INTERVAL_SEC) {
  const sec = clampCount(intervalSec) || DEFAULT_INTERVAL_SEC;

  if (timer) clearInterval(timer);

  console.log(
    "[autoNewsCron] starting — interval=%ss, status=%s, window=%s-%s, categories=%s",
    sec,
    DEFAULT_STATUS,
    WINDOW_START_HOUR,
    WINDOW_END_HOUR,
    FORCED_CATEGORIES.length ? FORCED_CATEGORIES.join(",") : "(auto)"
  );

  timer = setInterval(() => {
    runOnceAutoNews().catch((e) =>
      console.error("[autoNewsCron] tick error:", e?.message || e)
    );
  }, sec * 1000);
}

function getCronStatusSnapshot() {
  return {
    intervalSeconds: clampCount(DEFAULT_INTERVAL_SEC),
    enabled: !!timer,
    windowStartHour: WINDOW_START_HOUR,
    windowEndHour: WINDOW_END_HOUR,
    categories: FORCED_CATEGORIES,
    maxPerDay: MAX_PER_DAY,
    todayCountSaved,
    lastRunAt,
    lastStatus,
  };
}

module.exports = {
  startAutoNewsCron,
  runOnceAutoNews,
  getCronStatusSnapshot,
};
