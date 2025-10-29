// backend/src/controllers/automation.controller.js
"use strict";

const Parser = require("rss-parser");
const cheerio = require("cheerio");
const { DateTime } = require("luxon");
const slugify = require("slugify");
const jwt = require("jsonwebtoken");

// Node 18+ has global fetch; polyfill if not
const fetch = global.fetch || require("node-fetch");

const FeedSource = require("../models/FeedSource");
const FeedItem = require("../models/FeedItem");
const Article = require("../models/Article");
const { chooseHeroImage } = require("../services/imagePicker");

const { rewriteWithGuard } = require("../services/rewrite.service");
const { cleanseHtml } = require("../services/sanitize.service");


const {
  generateAutomationArticleDraft,
  callOpenRouter, // for debug ping
} = require("../services/openrouter.service");

/* -------------------- Config & helpers -------------------- */
const SITE_TZ = process.env.SITE_TZ || "Asia/Kolkata";
const DEFAULT_GEO_AREAS = (process.env.SITE_DEFAULT_GEO || "country:IN")
  .split(",")
  .map((s) => s.trim());

// ✅ fixed env var name typo
const MIN_EXTRACT_LEN = parseInt(
  process.env.AUTOMATION_MIN_EXTRACT_LEN || "250",
  10
);

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";

/* ---------- Auth helper (exported so routes can use it) ---------- */
exports.requireAuth = function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== "admin") throw new Error("not admin");
    req.user = { role: "admin" };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
};

function toIST(date) {
  try {
    return DateTime.fromJSDate(date)
      .setZone(SITE_TZ)
      .toFormat("yyyy-LL-dd'T'HH:mm:ssZZ");
  } catch {
    return DateTime.now()
      .setZone(SITE_TZ)
      .toFormat("yyyy-LL-dd'T'HH:mm:ssZZ");
  }
}

/* ---------- Robust helpers ---------- */
function safeJsonParse(raw) {
  if (!raw || typeof raw !== "string") return null;
  // Strip control chars that break JSON.parse
  const cleaned = raw.replace(/[\u0000-\u001F]+/g, "");
  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  // Try ```json ... ```
  const fence = cleaned.match(/```json\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch (_) {}
  }

  // Try from first { to last }
  const first = cleaned.indexOf("{"),
    last = cleaned.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(cleaned.slice(first, last + 1));
    } catch (_) {}
  }
  return null;
}

function toValidDate(input) {
  // Accept Date, ISO string, timestamp; default to now if invalid
  const d = input instanceof Date ? input : new Date(input);
  return isNaN(d.getTime()) ? new Date() : d;
}

function stripToText(html) {
  if (!html) return "";
  const $ = cheerio.load(html);

  // Remove non-article chrome
  $("script,style,noscript,header,footer,nav,aside,iframe").remove();

  // common paywall/boilerplate selectors (best-effort; harmless if not present)
  $('[class*="paywall"]').remove();
  $('[class*="subscribe"]').remove();
  $('[class*="advert"], [id*="advert"]').remove();

  const parts = [];
  // Prefer article blocks if present
  const article = $("article");
  const scope = article.length ? article : $("body");

  scope.find("p, h1, h2, h3, li").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t && t.length > 2) parts.push(t);
  });

  const text = parts.join("\n\n").trim();
  return text || $("body").text().replace(/\s+/g, " ").trim();
}

async function fetchHTML(url) {
  // Use a realistic desktop header set
  const headers = {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "accept-language": "en-GB,en;q=0.9",
    "cache-control": "no-cache",
    pragma: "no-cache",
  };

  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // Some sites use non-utf8; node-fetch handles most; if needed, add iconv here
  return await res.text();
}

/* -------------------- Debug -------------------- */
// GET /api/automation/_debug/automation-ping
exports.pingAutomation = async (_req, res) => {
  try {
    const model =
      process.env.OPENROUTER_MODEL_AUTOMATION || process.env.OPENROUTER_MODEL;

    const resp = await callOpenRouter({
      model,
      messages: [
        {
          role: "system",
          content: 'Return ONLY a JSON object exactly: {"ok": true}',
        },
        { role: "user", content: "ping" },
      ],
      temperature: 0.0,
    });

    return res.json({ ok: true, model, response: resp });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
};

/* -------------------- Endpoints -------------------- */

// GET /api/automation/feeds
exports.getFeeds = async (_req, res) => {
  const feeds = await FeedSource.find().sort({ createdAt: -1 });
  res.json(feeds);
};

// ✅ NEW: GET /api/automation/feeds/:id
exports.getFeedById = async (req, res) => {
  const feed = await FeedSource.findById(req.params.id);
  if (!feed) return res.status(404).json({ error: "Feed not found" });
  res.json(feed);
};

// POST /api/automation/feeds
exports.createFeed = async (req, res) => {
  const payload = req.body || {};
  const normalizedGeo = payload.geo
    ? {
        mode: String(payload.geo.mode || "global").toLowerCase(),
        areas: payload.geo.areas || DEFAULT_GEO_AREAS,
      }
    : { mode: "global", areas: DEFAULT_GEO_AREAS };

  const feed = await FeedSource.create({
    name: payload.name,
    url: payload.url,
    enabled: payload.enabled !== false,
    defaultCategory: payload.defaultCategory || "General",
    defaultAuthor: payload.defaultAuthor || "Desk",
    geo: normalizedGeo,
    schedule: payload.schedule || "manual",
  });
  res.status(201).json(feed);
};

// PATCH /api/automation/feeds/:id
exports.updateFeed = async (req, res) => {
  const body = { ...(req.body || {}) };
  if (body.geo) {
    body.geo = {
      mode: String(body.geo.mode || "global").toLowerCase(),
      areas: body.geo.areas || DEFAULT_GEO_AREAS,
    };
  }
  const feed = await FeedSource.findByIdAndUpdate(req.params.id, body, {
    new: true,
  });
  res.json(feed);
};

// DELETE /api/automation/feeds/:id
exports.deleteFeed = async (req, res) => {
  await FeedSource.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
};

/* ---------- Internal reusable fetch for a single feed ---------- */
exports._fetchSingleFeedInternal = async (feedDoc) => {
  const parser = new Parser({
    timeout: 15000,
    headers: {
      "User-Agent": "TimelyVoiceBot/1.0 (+https://www.timelyvoice.com)",
      Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
    },
  });

  const rss = await parser.parseURL(feedDoc.url);
  let created = 0,
    skipped = 0;

  for (const item of rss.items || []) {
    const link = item.link || item.guid;
    if (!link) {
      skipped++;
      continue;
    }

    const published = item.isoDate
      ? new Date(item.isoDate)
      : item.pubDate
      ? new Date(item.pubDate)
      : new Date();

    const exists = await FeedItem.findOne({
      $or: [{ link }, { guid: item.guid || null }],
    }).lean();
    if (exists) {
      skipped++;
      continue;
    }

    await FeedItem.create({
      feedId: feedDoc._id,
      sourceName: feedDoc.name,
      link,
      guid: item.guid || null,
      rawTitle: item.title || "",
      rawSummary: item.contentSnippet || item.summary || "",
      publishedAt: published,
      status: "fetched",
    });
    created++;
  }
  return { created, skipped, total: (rss.items || []).length };
};

// POST /api/automation/feeds/:id/fetch
exports.fetchFeed = async (req, res) => {
  const feed = await FeedSource.findById(req.params.id);
  if (!feed) return res.status(404).json({ error: "Feed not found" });
  if (!feed.enabled) return res.status(400).json({ error: "Feed disabled" });

  const r = await exports._fetchSingleFeedInternal(feed);
  res.json(r);
};

// ✅ NEW: POST /api/automation/feeds/fetch-all
exports.fetchAllFeeds = async (_req, res) => {
  const feeds = await FeedSource.find({ enabled: true }).lean();
  let totalCreated = 0,
    totalSkipped = 0;
  const perFeed = [];

  for (const f of feeds) {
    try {
      const r = await exports._fetchSingleFeedInternal(f);
      totalCreated += r.created;
      totalSkipped += r.skipped;
      perFeed.push({ feedId: String(f._id), created: r.created, skipped: r.skipped, total: r.total });
    } catch (e) {
      perFeed.push({
        feedId: String(f._id),
        error: String(e?.message || e),
      });
    }
  }
  res.json({
    ok: true,
    feeds: feeds.length,
    created: totalCreated,
    skipped: totalSkipped,
    results: perFeed,
  });
};

// GET /api/automation/items
exports.listItems = async (req, res) => {
  const { status, limit = 50 } = req.query;
  const q = {};
  if (status) {
    const arr = String(status)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    q.status = arr.length > 1 ? { $in: arr } : arr[0];
  }
  const items = await FeedItem.find(q)
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200));
  res.json(items);
};

// POST /api/automation/items/:id/extract
exports.extractItem = async (req, res) => {
  const item = await FeedItem.findById(req.params.id);
  if (!item) return res.status(404).json({ error: "Not found" });

  try {
    let text = "";
    let html = "";

    // 1) Try full page fetch & strip
    try {
      html = await fetchHTML(item.link);
      text = stripToText(html);
    } catch (e) {
      // Keep going—fallback next
      item.error = `fetch_failed:${e.message}`;
    }

    // 2) Fallback to RSS snippet if page blocked/too short
    if (!text || text.length < MIN_EXTRACT_LEN) {
      const fallback = String(item.rawSummary || "").trim();
      if (fallback && fallback.length >= Math.min(120, MIN_EXTRACT_LEN)) {
        text = fallback;
      }
    }

    // 3) Give up only if we still have nothing
    if (!text || text.length < Math.min(120, MIN_EXTRACT_LEN)) {
      item.status = "skipped";
      item.error = item.error || "too_short_or_unreadable";
    } else {
      item.extract = {
        html,
        text,
        author: item.extract?.author || "",
        site: item.sourceName || "",
        language: "en",
      };
      item.status = "extr";
      item.error = "";
    }

    await item.save();
    if (item.status === "skipped") {
      return res.status(500).json({ error: item.error });
    }
    res.json(item);
  } catch (e) {
    item.status = "skipped";
    item.error = `extract_failed:${e.message}`;
    await item.save();
    res.status(500).json({ error: item.error });
  }
};

// POST /api/automation/items/:id/generate
exports.generateItem = async (req, res) => {
  const item = await FeedItem.findById(req.params.id).populate("feedId");
  if (!item) return res.status(404).json({ error: "Not found" });

  // If already generated once, DON'T spend credits again
  if (item.status === "gen" && item.generated?.title) {
    return res.json(item);
  }

  if (!item.extract?.text) {
    return res.status(400).json({ error: "no_extract" });
  }

  // ↓↓↓ Cost control: keep prompt small
  const MAX_INPUT_CHARS = 5000; // you can lower to 3000 to save more
  const trimmedText = String(item.extract.text).slice(0, MAX_INPUT_CHARS);

  const feed = item.feedId;
  const defaults = {
    author: feed?.defaultAuthor || "Desk",
    category: feed?.defaultCategory || "General",
    geo: feed?.geo || { mode: "global", areas: DEFAULT_GEO_AREAS },
  };

  const publishAt = toIST(item.publishedAt || new Date());

  let json = null;
  let rewriteFailed = false;

  // ---------- 1) PRIMARY: rewrite with anti-copy guard ----------
  try {
    const sourceBlob = {
      url: item.link,
      title: item.rawTitle || "",
      description: item.rawSummary || "",
      content: trimmedText || "",
      category: defaults.category || "",
      tags: Array.isArray(item.tags) ? item.tags : [],
    };

    const rewritten = await rewriteWithGuard(sourceBlob);

    json = {
      title: rewritten.title || (item.rawTitle || "Untitled"),
      summary: rewritten.summary || (item.rawSummary || ""),
      // sanitize NOW so language rails / menus never leak
      body: cleanseHtml(rewritten.bodyHtml || ""),
      author: defaults.author,
      category: defaults.category,
      publishAt,
      geo: defaults.geo,
      tags: [],
      seo: {
        metaTitle: (rewritten.title || item.rawTitle || "").slice(0, 80),
        metaDescription: (rewritten.summary || item.rawSummary || "").slice(0, 200),
        imageAlt: rewritten.title || item.rawTitle || "",
      },
    };
  } catch (e) {
    rewriteFailed = true;
  }

  // ---------- 2) FALLBACK: old generator (but still sanitized) ----------
  if (!json) {
    try {
      let g = await generateAutomationArticleDraft({
        extractedText: trimmedText,
        rssLink: item.link,
        defaults: { ...defaults, publishAt },
      });
      if (typeof g === "string") {
        const parsed = safeJsonParse(g);
        if (parsed) g = parsed;
      }

      // Always sanitize the body coming from the old path
      const rawBody = g.bodyHtml || g.body || item.extract.text || "";
      json = {
        title: g.title || item.rawTitle || "Untitled",
        summary: g.summary || item.rawSummary || "",
        body: cleanseHtml(rawBody),
        author: g.author || defaults.author,
        category: g.category || defaults.category,
        publishAt: g.publishAt || publishAt,
        geo: g.geo || defaults.geo,
        tags: Array.isArray(g.tags) ? g.tags : [],
        seo: g.seo || { metaTitle: "", metaDescription: "", imageAlt: "" },
      };
    } catch (e2) {
      // Minimal last-resort so pipeline continues
      json = {
        title: item.rawTitle || "Untitled",
        summary: item.rawSummary || "",
        author: defaults.author,
        category: defaults.category,
        publishAt,
        geo: defaults.geo,
        body: cleanseHtml((item.extract.text || "").slice(0, 1000)),
        tags: [],
        seo: { metaTitle: "", metaDescription: "", imageAlt: "" },
      };
    }
  }

  // --- normalize to Article schema (flat SEO + GEO) ---
  json = json || {};
  json.imageUrl = json.imageUrl || "";
  json.imagePublicId = json.imagePublicId || "";
  json.status = "draft";

  json.publishAt = json.publishAt || publishAt;
  json.author = json.author || defaults.author;
  json.category = json.category || defaults.category;

  // ensure body is sanitized (even if already done above)
  json.body = cleanseHtml(json.body || json.bodyHtml || "");

  const seo = json.seo || {};
  json.imageAlt = seo.imageAlt || json.title || "";
  json.metaTitle = (seo.metaTitle || json.title || "").slice(0, 80);
  json.metaDesc = (seo.metaDescription || json.summary || "").slice(0, 200);
  json.ogImage = (seo.ogImageUrl || "").trim();

  const geo = json.geo || defaults.geo || { mode: "global", areas: [] };
  json.geoMode = String(geo.mode || "global").toLowerCase();
  json.geoAreas = Array.isArray(geo.areas) ? json.geo.areas.map(String) : [];

  if (!Array.isArray(json.tags)) json.tags = [];
  json.tags = [
    ...new Set(json.tags.map((t) => String(t).trim()).filter(Boolean)),
  ].slice(0, 6);

  json.slug =
    slugify(json.slug || json.title || "article", {
      lower: true,
      strict: true,
    }) || `article-${Date.now()}`;

  // Save on the item
  item.generated = json;
  item.status = "gen";
  item.error = rewriteFailed ? "rewrite_failed_used_fallback" : "";
  await item.save();

  res.json(item);
};



// POST /api/automation/items/:id/mark-ready
exports.markReady = async (req, res) => {
  try {
    const doc = await FeedItem.findByIdAndUpdate(
      req.params.id,
      { status: "ready", error: "" },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
};

// POST /api/automation/items/:id/draft
exports.createDraft = async (req, res) => {
  const item = await FeedItem.findById(req.params.id);
  if (!item) return res.status(404).json({ error: "Not found" });
  if (!item.generated) return res.status(400).json({ error: "not_generated" });

   const g = item.generated;

  // ---- compute slug early so picker can use it (for exact match) ----
  const baseSlug =
    g.slug ||
    slugify(g.title || "article", { lower: true, strict: true }) ||
    `article-${Date.now()}`;

  // If the generator did not provide an image, pick one from Cloudinary
  // IMPORTANT: Admin list builds the preview from imagePublicId itself.
  if (!g.imagePublicId) {
    const picked = await chooseHeroImage({
      title: g.title,
      summary: g.summary,
      category: g.category,
      tags: g.tags,
      slug: baseSlug, // pass slug to enable exact-slug fast path
    });

    // Set ONLY the public id for the Admin "quick URL" widget
    g.imagePublicId = picked.publicId;

    // Leave imageUrl empty; Admin composes it from publicId.
    g.imageUrl = g.imageUrl || "";

    // Keep a full transformed URL for social previews/open graph
    if (!g.ogImage) g.ogImage = picked.url;

    // Alt text fallback
    if (!g.imageAlt) g.imageAlt = g.title || "Article image";

    // Optional: during QA, see why an image was chosen
    // console.log("[image-pick]", { title: g.title, publicId: g.imagePublicId, why: picked.why });
  }

  // ---- safe publishAt ----
  let publishAt = toValidDate(g.publishAt || Date.now());

  // ---- unique slug (auto -2, -3) ----
  let finalSlug = baseSlug;
  let suffix = 2;
  while (await Article.exists({ slug: finalSlug })) {
    finalSlug = `${baseSlug}-${suffix++}`;
  }


  // Create the article
  const doc = await Article.create({
    title: g.title,
    slug: finalSlug,

    summary: g.summary || "",
    author: g.author || "Desk",
    category: g.category || "General",

    status: "draft",
    publishAt, // safe date

    imageUrl: g.imageUrl || "",
    imagePublicId: g.imagePublicId || "",

    // SEO (flat)
    imageAlt: g.imageAlt || g.title || "",
    metaTitle: (g.metaTitle || g.title || "").slice(0, 80),
    metaDesc: (g.metaDesc || g.summary || "").slice(0, 200),
    ogImage: g.ogImage || "",

    // GEO (flat)
    geoMode: g.geoMode || "global",
    geoAreas: Array.isArray(g.geoAreas) ? g.geoAreas : [],

    tags: Array.isArray(g.tags) ? g.tags : [],
    body: g.body || "",

    sourceUrl: item.link,
  });

  item.status = "drafted";
  item.articleId = doc._id;
  await item.save();

  res.json({ ok: true, articleId: doc._id });
};

/* ---------- Batch processor for Admin button ---------- */
// POST /api/automation/process   { limit?: number }
exports.processBatch = async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.body?.limit || "10", 10), 1), 25);

  // newest first to keep the UI feeling responsive
  const items = await FeedItem.find({
    status: { $in: ["fetched", "extr", "gen"] },
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  const results = [];
  for (const it of items) {
    const r = { itemId: String(it._id), steps: [], ok: true };
    try {
      // 1) extract (if needed)
      if (it.status === "fetched") {
        r.steps.push("extract");
        await exports.extractItem(
          { params: { id: it._id } },
          {
            json: () => {},
            status: () => ({ json: () => {} }),
          }
        );
      }

      // reload
      let live = await FeedItem.findById(it._id);

      // 2) generate (if needed)
      if (live && live.status === "extr") {
        r.steps.push("generate");
        try {
          await exports.generateItem(
            { params: { id: it._id } },
            { json: () => {} }
          );
        } catch {
          // one retry is often enough if the model hiccups
          await exports.generateItem(
            { params: { id: it._id } },
            { json: () => {} }
          );
        }
      }

      live = await FeedItem.findById(it._id);

      // 3) draft (if generated)
      if (live && live.status === "gen") {
        r.steps.push("draft");
        const tmp = { _json: null };
        await exports.createDraft(
          { params: { id: it._id } },
          {
            json: (obj) => (tmp._json = obj),
            status: () => ({ json: (obj) => (tmp._json = obj) }),
          }
        );
        if (tmp._json?.articleId) {
          r.articleId = String(tmp._json.articleId);
          const a = await Article.findById(tmp._json.articleId).lean();
          r.slug = a?.slug;
        }
      }
    } catch (e) {
      r.ok = false;
      r.error = String(e?.message || e);
    }
    results.push(r);
  }

  const success = results.filter((x) => x.ok).length;
  res.json({ ok: true, count: results.length, success, results });
};
// POST /api/automation/items/:id/run
exports.runSingle = async (req, res) => {
  const id = req.params.id;

  // Step 1: extract (if needed)
  try {
    await exports.extractItem(
      { params: { id } },
      { json: () => {}, status: () => ({ json: () => {} }) }
    );
  } catch (e) {
    // ignore if already extracted/generated; we’ll try the next steps
  }

  // Step 2: generate (if needed)
  try {
    await exports.generateItem(
      { params: { id } },
      { json: () => {}, status: () => ({ json: () => {} }) }
    );
  } catch (e) {
    // safe to proceed; may already be generated
  }

  // Step 3: createDraft
  let articleId = null;
  try {
    let out;
    await exports.createDraft(
      { params: { id } },
      { json: (r) => (out = r), status: () => ({ json: () => {} }) }
    );
    articleId = out?.articleId || out?._id || null;
  } catch (e) {
    // If already drafted, we still try markReady; otherwise bubble up
    if (!/already/i.test(String(e?.message || e))) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }

  // Step 4: markReady (optional; keeps parity with your current flow)
  try {
    await exports.markReady(
      { params: { id } },
      { json: () => {}, status: () => ({ json: () => {} }) }
    );
  } catch (_) {}

  res.json({ ok: true, articleId });
};
