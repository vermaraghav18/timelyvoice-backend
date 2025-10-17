// backend/src/controllers/x.controller.js
"use strict";

const { DateTime } = require("luxon");
const cheerio = require("cheerio");

const XSource = require("../models/XSource");
const XItem = require("../models/XItem");
const Article = require("../models/Article");

const { userByUsername, userTweets } = require("../services/x.api");
const { isGovUrl } = require("../services/govWhitelist");

const { generateJSONDraft } = require("../services/openrouter.service");
const slugify = require("slugify");

// Node 18+ has global fetch; polyfill if not
const fetch = global.fetch || require("node-fetch");

/* =========================
   Sources (handles)
========================= */

exports.listXSources = async (req, res) => {
  const rows = await XSource.find().sort({ updatedAt: -1 }).lean();
  res.json({ ok: true, rows });
};

exports.createXSource = async (req, res) => {
  const {
    handle = "",
    label = "",
    enabled = true,
    defaultAuthor = "Desk",
    defaultCategory = "Politics",
    geo = { mode: "Global", areas: [] },
    schedule = "",
    notes = "",
  } = req.body || {};

  if (!handle) return res.status(400).json({ ok: false, error: "handle required" });

  const row = await XSource.create({
    handle: handle.replace(/^@/, ""),
    label,
    enabled,
    defaultAuthor,
    defaultCategory,
    geo,
    schedule,
    notes,
  });
  res.json({ ok: true, row });
};

exports.updateXSource = async (req, res) => {
  const { id } = req.params;
  const patch = req.body || {};
  if (patch.handle) patch.handle = patch.handle.replace(/^@/, "");
  const row = await XSource.findByIdAndUpdate(id, patch, { new: true });
  res.json({ ok: true, row });
};

exports.deleteXSource = async (req, res) => {
  const { id } = req.params;
  await XSource.findByIdAndDelete(id);
  res.json({ ok: true });
};

/**
 * Fetch latest tweets for a given source handle and store as XItems.
 * Route: POST /api/automation/x/sources/:id/fetch
 *
 * NOTE: This version uses the existing x.api helpers (userByUsername, userTweets).
 * It does NOT reference undefined helpers, which was causing the 500.
 */
exports.fetchXSource = async (req, res) => {
  const { id } = req.params;

  const src = await XSource.findById(id);
  if (!src) return res.status(404).json({ ok: false, error: "not found" });

  // Resolve user id from handle
  const userResp = await userByUsername(src.handle);
  const userId = userResp?.data?.id;
  if (!userId) return res.status(400).json({ ok: false, error: "user not found" });

  // Pull tweets since last seen id (if any)
  const tw = await userTweets(userId, src.sinceId || "");
  const data = tw?.data || [];
  const media = tw?.includes?.media || [];

  // Index media by media_key
  const mediaIndex = {};
  for (const m of media) mediaIndex[m.media_key] = m;

  let maxId = src.sinceId || "";
  const created = [];

  for (const t of data) {
    const xId = t.id;
    if (!maxId || BigInt(xId) > BigInt(maxId)) maxId = xId;

    // URLs in entities
    const urls = (t.entities?.urls || [])
      .map((u) => u.expanded_url)
      .filter(Boolean);

    // media (optional)
    const mks = t.attachments?.media_keys || [];
    const medias = mks
      .map((k) => mediaIndex[k])
      .filter(Boolean)
      .map((m) => ({
        type: m.type,
        url: m.url || m.preview_image_url || "",
      }));

    // Dedupe by tweet id
    const exists = await XItem.findOne({ xId });
    if (exists) continue;

    const doc = await XItem.create({
      xId,
      handle: src.handle,                 // stored without '@'
      tweetedAt: new Date(t.created_at),
      text: t.text || "",
      html: "",                           // optional rendering later
      media: medias,
      urls,
      status: "new",
    });
    created.push(doc);
  }

  // Advance sinceId checkpoint
  if (maxId && maxId !== src.sinceId) {
    src.sinceId = maxId;
    await src.save();
  }

  res.json({ ok: true, created: created.length });
};

/* =========================
   Items (tweets)
========================= */

exports.listXItems = async (req, res) => {
  const { status, handle, limit = 50 } = req.query;
  const q = {};
  if (status) q.status = status;
  if (handle) q.handle = handle.replace(/^@/, "");
  const rows = await XItem.find(q).sort({ tweetedAt: -1 }).limit(Number(limit)).lean();
  res.json({ ok: true, rows });
};

async function fetchHTML(url) {
  const headers = {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    accept: "text/html,application/xhtml+xml",
  };
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${res.statusText}`);
  return res.text();
}

function extractReadableText(html) {
  const $ = cheerio.load(html);
  const scope = $("main, article, #content, .content, .container, body").first();
  const parts = [];
  scope.find("h1, h2, h3, p, li").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t && t.length > 2) parts.push(t);
  });
  const text = parts.join("\n\n").trim();
  return text || $("body").text().replace(/\s+/g, " ").trim();
}

exports.extractXItem = async (req, res) => {
  const { id } = req.params;
  const item = await XItem.findById(id);
  if (!item) return res.status(404).json({ ok: false, error: "not found" });

  const sources = [];
  for (const u of item.urls || []) {
    if (!isGovUrl(u)) continue;
    try {
      const html = await fetchHTML(u);
      const text = extractReadableText(html);
      sources.push({
        url: u,
        score: 1.0,
        why: "Linked from tweet",
        title: "",
        publishedAt: null,
        text,
      });
    } catch (e) {
      // swallow and continue
    }
  }

  const combinedText =
    (sources.map((s) => s.text).filter(Boolean).join("\n\n").trim()) ||
    item.text ||
    "";

  item.extract = {
    text: combinedText,
    html: "",
    sources: sources.map(({ url, score, why, title, publishedAt }) => ({
      url,
      score,
      why,
      title,
      publishedAt,
    })),
  };
  item.status = "extracted";
  await item.save();

  res.json({ ok: true, item });
};

exports.generateXItem = async (req, res) => {
  const { id } = req.params;
  const item = await XItem.findById(id);
  if (!item) return res.status(404).json({ ok: false, error: "not found" });

  const src = await XSource.findOne({ handle: item.handle });
  const defaults = {
    author: src?.defaultAuthor || "Desk",
    category: src?.defaultCategory || "Politics",
    geo: src?.geo || { mode: "Global", areas: [] },
    publishAt: DateTime.now().setZone("Asia/Kolkata").toISO(),
  };

  // Prefer XGEN model if provided; otherwise global default
  const modelForXGen =
    process.env.OPENROUTER_MODEL_XGEN || process.env.OPENROUTER_MODEL;

  try {
    const tweetText = item.text || "";
    const extractText = (item.extract?.text || "").trim();

    const draft = await generateJSONDraft({
      tweetText,
      extractText,
      defaults,
      sources: item.extract?.sources || [],
      model: modelForXGen,
    });

    if (!draft.title || !draft.title.trim()) {
      draft.title = (extractText || tweetText || "Update from " + item.handle)
        .split(".")[0]
        .slice(0, 78);
    }
    if (!draft.slug || !draft.slug.trim()) {
      draft.slug = slugify(draft.title, { lower: true, strict: true }) + "-" + item.xId;
    }
    if (!draft.summary) draft.summary = (extractText || tweetText || "").slice(0, 420);
    if (!draft.body) draft.body = extractText || tweetText || "";
    if (!draft.sourceUrl) {
      draft.sourceUrl = (item.urls || []).find((u) => isGovUrl(u)) || "";
    }

    item.generated = draft;
    item.status = "generated";
    await item.save();

    res.json({ ok: true, item });
  } catch (e) {
    console.error("[Generate] OpenRouter error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};

exports.markReadyXItem = async (req, res) => {
  const { id } = req.params;
  const item = await XItem.findById(id);
  if (!item) return res.status(404).json({ ok: false, error: "not found" });
  item.status = "ready";
  await item.save();
  res.json({ ok: true, item });
};

exports.createDraftFromXItem = async (req, res) => {
  const { id } = req.params;
  const item = await XItem.findById(id);
  if (!item) return res.status(404).json({ ok: false, error: "not found" });
  if (!item.generated) return res.status(400).json({ ok: false, error: "generate first" });

  const g = item.generated;

  const art = await Article.create({
    title: g.title || "Untitled",
    slug:
      g.slug ||
      require("slugify")(g.title || "untitled", { lower: true, strict: true }) +
        "-" +
        item.xId,
    summary: g.summary || "",
    body: g.body || "",
    author: g.author || "Desk",
    category: g.category || "Politics",
    status: "Draft",
    publishedAt: g.publishAt ? new Date(g.publishAt) : null,
    imageUrl: "",
    imagePublicId: "",
    seo: g.seo || {},
    geo: g.geo || { mode: "Global", areas: [] },
    sourceUrl: g.sourceUrl || "",
  });

  item.articleId = art._id;
  item.status = "drafted";
  await item.save();

  res.json({ ok: true, articleId: art._id });
};
