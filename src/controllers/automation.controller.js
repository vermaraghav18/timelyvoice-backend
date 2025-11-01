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
const { finalizeArticleImages } = require("../services/finalizeArticleImages");

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

const MIN_EXTRACT_WORDS = parseInt(
  process.env.AUTOMATION_MIN_EXTRACT_WORDS || process.env.AUTOMATION_MIN_EXTRACT_LEN || "800",
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

function canonicalUrl(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  try {
    const u = new URL(raw.trim());
    ['utm_source','utm_medium','utm_campaign','utm_term','utm_content'].forEach(p => u.searchParams.delete(p));
    u.hash = '';
    const s = u.toString().replace(/\/+$/, '');
    return s;
  } catch {
    return raw.trim();
  }
}

function urlVariants(raw) {
  const c = canonicalUrl(raw);
  const variants = new Set([c]);
  variants.add(c + '/');
  try {
    const u = new URL(c);
    if (u.protocol === 'https:') {
      const http = c.replace(/^https:/, 'http:');
      variants.add(http);
      variants.add(http + '/');
    } else if (u.protocol === 'http:') {
      const https = c.replace(/^http:/, 'https:');
      variants.add(https);
      variants.add(https + '/');
    }
  } catch {}
  return [...variants];
}

function safeJsonParse(raw) {
  if (!raw || typeof raw !== "string") return null;
  const cleaned = raw.replace(/[\u0000-\u001F]+/g, "");
  try { return JSON.parse(cleaned); } catch (_){}

  const fence = cleaned.match(/```json\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1]); } catch (_) {} }

  const first = cleaned.indexOf("{"), last = cleaned.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try { return JSON.parse(cleaned.slice(first, last + 1)); } catch (_){}
  }
  return null;
}

function toValidDate(input) {
  const d = input instanceof Date ? input : new Date(input);
  return isNaN(d.getTime()) ? new Date() : d;
}

function plain(s=''){ return String(s).replace(/<[^>]*>/g,' '); }
function wc(s=''){ return plain(s).trim().split(/\s+/).filter(Boolean).length; }

function stripToText(html) {
  if (!html) return "";
  const $ = cheerio.load(html);
  $("script,style,noscript,header,footer,nav,aside,iframe").remove();
  $('[class*="paywall"]').remove();
  $('[class*="subscribe"]').remove();
  $('[class*="advert"], [id*="advert"]').remove();

  const parts = [];
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
  return await res.text();
}

/* -------------------- Debug -------------------- */
exports.pingAutomation = async (_req, res) => {
  try {
    const model =
      process.env.OPENROUTER_MODEL_AUTOMATION || process.env.OPENROUTER_MODEL;

    const resp = await callOpenRouter({
      model,
      messages: [
        { role: "system", content: 'Return ONLY a JSON object exactly: {"ok": true}' },
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

// GET /api/automation/feeds/:id
exports.getFeedById = async (req, res) => {
  const feed = await FeedSource.findById(req.params.id);
  if (!feed) return res.status(404).json({ error: "Feed not found" });
  res.json(feed);
};

// POST /api/automation/feeds
exports.createFeed = async (req, res) => {
  try {
    const payload = req.body || {};
    const normalizedGeo = payload.geo
      ? { mode: String(payload.geo.mode || "global").toLowerCase(),
          areas: payload.geo.areas || DEFAULT_GEO_AREAS }
      : { mode: "global", areas: DEFAULT_GEO_AREAS };

    const feed = await FeedSource.findOneAndUpdate(
      { url: payload.url },
      {
        $setOnInsert: {
          name: payload.name,
          url: canonicalUrl(payload.url),
          enabled: payload.enabled !== false,
          defaultCategory: payload.defaultCategory || "General",
          defaultAuthor: payload.defaultAuthor || "Desk",
          geo: normalizedGeo,
          schedule: payload.schedule || "manual",
        }
      },
      { new: true, upsert: true }
    );

    res.status(201).json(feed);
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
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
  const feed = await FeedSource.findByIdAndUpdate(req.params.id, body, { new: true });
  res.json(feed);
};

// DELETE /api/automation/feeds/:id (with ?allByUrl=1 to nuke variants)
exports.deleteFeed = async (req, res) => {
  const { allByUrl } = req.query;
  const doc = await FeedSource.findById(req.params.id).lean();
  if (!doc) return res.json({ ok: true, deleted: 0 });

  let result;
  if (String(allByUrl) === '1') {
    const variants = urlVariants(doc.url);
    result = await FeedSource.deleteMany({ url: { $in: variants } });
  } else {
    result = await FeedSource.deleteOne({ _id: doc._id });
  }
  res.json({ ok: true, deleted: result?.deletedCount || 0, url: canonicalUrl(doc.url) });
};

// DELETE /api/automation/feeds/_dedupe
exports.dedupeFeeds = async (_req, res) => {
  const all = await FeedSource.find({ url: { $type: "string" } }, { _id: 1, url: 1, createdAt: 1 }).lean();
  const groups = new Map();
  for (const d of all) {
    const key = canonicalUrl(d.url);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  const toDelete = [];
  for (const [, arr] of groups) {
    arr.sort((a,b) => b.createdAt - a.createdAt);
    for (let i = 1; i < arr.length; i++) toDelete.push(arr[i]._id);
  }
  if (toDelete.length === 0) return res.json({ ok: true, deleted: 0 });
  const r = await FeedSource.deleteMany({ _id: { $in: toDelete } });
  res.json({ ok: true, deleted: r.deletedCount || 0 });
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
  let created = 0, skipped = 0;

  for (const item of rss.items || []) {
    const link = item.link || item.guid;
    if (!link) { skipped++; continue; }

    const published = item.isoDate
      ? new Date(item.isoDate)
      : item.pubDate
      ? new Date(item.pubDate)
      : new Date();

    const exists = await FeedItem.findOne({ $or: [{ link }, { guid: item.guid || null }] }).lean();
    if (exists) { skipped++; continue; }

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

// POST /api/automation/feeds/fetch-all
exports.fetchAllFeeds = async (_req, res) => {
  const feeds = await FeedSource.find({ enabled: true }).lean();
  let totalCreated = 0, totalSkipped = 0;
  const perFeed = [];

  for (const f of feeds) {
    try {
      const r = await exports._fetchSingleFeedInternal(f);
      totalCreated += r.created;
      totalSkipped += r.skipped;
      perFeed.push({ feedId: String(f._id), created: r.created, skipped: r.skipped, total: r.total });
    } catch (e) {
      perFeed.push({ feedId: String(f._id), error: String(e?.message || e) });
    }
  }
  res.json({ ok: true, feeds: feeds.length, created: totalCreated, skipped: totalSkipped, results: perFeed });
};

// GET /api/automation/items
exports.listItems = async (req, res) => {
  const { status, limit = 50 } = req.query;
  const q = {};
  if (status) {
    const arr = String(status).split(",").map(s => s.trim()).filter(Boolean);
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

    try {
      html = await fetchHTML(item.link);
      text = stripToText(html);
    } catch (e) {
      item.error = `fetch_failed:${e.message}`;
    }

    if (!text || wc(text) < MIN_EXTRACT_WORDS) {
      const fallback = String(item.rawSummary || "").trim();
      if (fallback && wc(fallback) >= Math.min(120, MIN_EXTRACT_WORDS)) {
        text = fallback;
      }
    }

    if (!text || wc(text) < Math.min(120, MIN_EXTRACT_WORDS)) {
      item.status = "skipped";
      item.error = item.error || `too_short_or_unreadable (< ${MIN_EXTRACT_WORDS} words)`;
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

  if (item.status === "gen" && item.generated?.title) {
    return res.json(item);
  }

  if (!item.extract?.text) {
    return res.status(400).json({ error: "no_extract" });
  }

  if (wc(item.extract.text) < MIN_EXTRACT_WORDS) {
    return res.status(400).json({ error: `extract_too_short_<${MIN_EXTRACT_WORDS}_words` });
  }

  const MAX_INPUT_CHARS = 5000;
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

  // normalize for later drafting
  json = json || {};
  json.imageUrl = json.imageUrl || "";
  json.imagePublicId = json.imagePublicId || "";
  json.status = "draft";

  json.publishAt = json.publishAt || publishAt;
  json.author = json.author || defaults.author;
  json.category = json.category || defaults.category;

  json.body = cleanseHtml(json.body || json.bodyHtml || "");

  const seo = json.seo || {};
  json.imageAlt = seo.imageAlt || json.title || "";
  json.metaTitle = (seo.metaTitle || json.title || "").slice(0, 80);
  json.metaDesc  = (seo.metaDescription || json.summary || "").slice(0, 200);
  json.ogImage   = (seo.ogImageUrl || "").trim();

  const geo = json.geo || defaults.geo || { mode: "global", areas: [] };
  json.geoMode = String(geo.mode || "global").toLowerCase();
  json.geoAreas = Array.isArray(geo.areas) ? geo.areas.map(String) : [];

  if (!Array.isArray(json.tags)) json.tags = [];
  json.tags = [...new Set(json.tags.map(t => String(t).trim()).filter(Boolean))].slice(0, 6);

  json.slug =
    slugify(json.slug || json.title || "article", { lower: true, strict: true }) ||
    `article-${Date.now()}`;

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

  const ARTICLE_MIN_BODY = parseInt(process.env.ARTICLE_MIN_BODY || '450', 10);
  const bodyForCount = (g.body && g.body.trim().length) ? g.body : (g.bodyHtml || '');
  if (wc(bodyForCount) < ARTICLE_MIN_BODY) {
    return res.status(400).json({
      error: `generated_body_too_short_<${ARTICLE_MIN_BODY}_words`,
      gotWords: wc(bodyForCount) || 0
    });
  }

  // compute base slug so picker can match exact if asset exists
  const baseSlug =
    g.slug ||
    slugify(g.title || "article", { lower: true, strict: true }) ||
    `article-${Date.now()}`;

  // Build payload for Article and FINALIZE IMAGES here (single source of truth)
  const payload = {
    title: g.title,
    slug: baseSlug,
    summary: g.summary || "",
    author: g.author || "Desk",
    category: g.category || "General",
    status: "draft",
    publishAt: toValidDate(g.publishAt || Date.now()),
    imageUrl: g.imageUrl || null,         // normalize empties
    imagePublicId: g.imagePublicId || null,
    imageAlt: g.imageAlt || g.title || "",
    metaTitle: (g.metaTitle || g.title || "").slice(0, 80),
    metaDesc: (g.metaDesc || g.summary || "").slice(0, 200),
    ogImage: g.ogImage || null,
    geoMode: g.geoMode || "global",
    geoAreas: Array.isArray(g.geoAreas) ? g.geoAreas : [],
    tags: Array.isArray(g.tags) ? g.tags : [],
    body: g.body || "",
    sourceUrl: item.link,
  };

  // ← This call guarantees publicId + hero + og + thumb even if imageUrl is empty
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

  payload.imagePublicId = fin.imagePublicId;
  payload.imageUrl      = fin.imageUrl;
  payload.ogImage       = fin.ogImage;
  payload.thumbImage    = fin.thumbImage;
  payload.imageAlt      = payload.imageAlt || fin.imageAlt;

  // ensure unique slug
  let finalSlug = payload.slug;
  let suffix = 2;
  while (await Article.exists({ slug: finalSlug })) {
    finalSlug = `${payload.slug}-${suffix++}`;
  }
  payload.slug = finalSlug;

  const doc = await Article.create(payload);

  item.status = "drafted";
  item.articleId = doc._id;
  await item.save();

  res.json({ ok: true, articleId: doc._id });
};

/* ---------- Batch processor for Admin button ---------- */
exports.processBatch = async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.body?.limit || "10", 10), 1), 25);

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
      if (it.status === "fetched") {
        r.steps.push("extract");
        await exports.extractItem(
          { params: { id: it._id } },
          { json: () => {}, status: () => ({ json: () => {} }) }
        );
      }

      let live = await FeedItem.findById(it._id);

      if (live && live.status === "extr") {
        r.steps.push("generate");
        try {
          await exports.generateItem(
            { params: { id: it._id } },
            { json: () => {} }
          );
        } catch {
          await exports.generateItem(
            { params: { id: it._id } },
            { json: () => {} }
          );
        }
      }

      live = await FeedItem.findById(it._id);

      if (live && live.status === "gen") {
        r.steps.push("draft");
        const tmp = { _json: null };
        await exports.createDraft(
          { params: { id: it._id } },
          { json: (obj) => (tmp._json = obj), status: () => ({ json: (obj) => (tmp._json = obj) }) }
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

  try {
    await exports.extractItem(
      { params: { id } },
      { json: () => {}, status: () => ({ json: () => {} }) }
    );
  } catch (_) {}

  try {
    await exports.generateItem(
      { params: { id } },
      { json: () => {}, status: () => ({ json: () => {} }) }
    );
  } catch (_) {}

  let articleId = null;
  try {
    let out;
    await exports.createDraft(
      { params: { id } },
      { json: (r) => (out = r), status: () => ({ json: () => {} }) }
    );
    articleId = out?.articleId || out?._id || null;
  } catch (e) {
    if (!/already/i.test(String(e?.message || e))) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }

  try {
    await exports.markReady(
      { params: { id } },
      { json: () => {}, status: () => ({ json: () => {} }) }
    );
  } catch (_) {}

  res.json({ ok: true, articleId });
};
