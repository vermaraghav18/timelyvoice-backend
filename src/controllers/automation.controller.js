// backend/src/controllers/automation.controller.js
"use strict";

const Parser = require("rss-parser");
const cheerio = require("cheerio");
const { DateTime } = require("luxon");
const slugify = require("slugify");

// Node 18+ has global fetch; polyfill if not
const fetch = global.fetch || require("node-fetch");

const FeedSource = require("../models/FeedSource");
const FeedItem = require("../models/FeedItem");
const Article = require("../models/Article");
const { chooseHeroImage } = require("../services/imagePicker");

/* -------------------- Config & helpers -------------------- */
const SITE_TZ = process.env.SITE_TZ || "Asia/Kolkata";
const DEFAULT_GEO_AREAS = (process.env.SITE_DEFAULT_GEO || "country:IN")
  .split(",")
  .map((s) => s.trim());

// Lower this if many sites only expose short text
const MIN_EXTRACT_LEN = parseInt(process.env.AUTMOTION_MIN_EXTRACT_LEN || "250", 10);

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
    "accept":
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

/* -------------------- OpenRouter (LIVE) -------------------- */
async function openrouterGenerate(prompt) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY missing");
  const model = process.env.OPENROUTER_MODEL || "anthropic/claude-3.7-sonnet";

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      // "HTTP-Referer": process.env.FRONTEND_BASE_URL || "https://www.timelyvoice.com",
      // "X-Title": "Timely Voice Autmotion",
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content:
            "You are a newsroom editor for Timely Voice. Return ONLY valid JSON that matches the required schema. Do not include markdown or fencing. Keep metaTitle <= 80 chars and metaDescription <= 200 chars.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenRouter ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || "";

  // If any prose is around the JSON, grab the last JSON block
  const jsonBlock = content.match(/\{[\s\S]*\}$/)?.[0] || content;

  let parsed;
  try {
    parsed = JSON.parse(jsonBlock);
  } catch {
    const cleaned = jsonBlock.replace(/```json/gi, "").replace(/```/g, "").trim();
    parsed = JSON.parse(cleaned);
  }

  return parsed;
}

/* -------------------- Endpoints -------------------- */

// GET /api/automation/feeds
exports.getFeeds = async (_req, res) => {
  const feeds = await FeedSource.find().sort({ createdAt: -1 });
  res.json(feeds);
};

// POST /api/automation/feeds
exports.createFeed = async (req, res) => {
  const payload = req.body || {};
  const feed = await FeedSource.create({
    name: payload.name,
    url: payload.url,
    enabled: payload.enabled !== false,
    defaultCategory: payload.defaultCategory || "General",
    defaultAuthor: payload.defaultAuthor || "Desk",
    geo: payload.geo || { mode: "Global", areas: DEFAULT_GEO_AREAS },
    schedule: payload.schedule || "manual",
  });
  res.status(201).json(feed);
};

// PATCH /api/automation/feeds/:id
exports.updateFeed = async (req, res) => {
  const feed = await FeedSource.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });
  res.json(feed);
};

// DELETE /api/automation/feeds/:id
exports.deleteFeed = async (req, res) => {
  await FeedSource.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
};

// POST /api/automation/feeds/:id/fetch
exports.fetchFeed = async (req, res) => {
  const feed = await FeedSource.findById(req.params.id);
  if (!feed) return res.status(404).json({ error: "Feed not found" });
  if (!feed.enabled) return res.status(400).json({ error: "Feed disabled" });

  const parser = new Parser();
  const rss = await parser.parseURL(feed.url);

  const out = [];
  for (const item of rss.items || []) {
    const link = item.link || item.guid;
    if (!link) continue;

    const published = item.isoDate
      ? new Date(item.isoDate)
      : item.pubDate
      ? new Date(item.pubDate)
      : new Date();

    const doc = await FeedItem.findOneAndUpdate(
      { $or: [{ link }, { guid: item.guid || null }] },
      {
        $setOnInsert: {
          feedId: feed._id,
          sourceName: feed.name,
          link,
          guid: item.guid || null,
          rawTitle: item.title || "",
          rawSummary: item.contentSnippet || item.summary || "",
          publishedAt: published,
          status: "fetched",
        },
      },
      { upsert: true, new: true }
    );
    out.push(doc);
  }

  res.json({ count: out.length });
};

// GET /api/automation/items
exports.listItems = async (req, res) => {
  const { status, limit = 50 } = req.query;
  const q = {};
  if (status) q.status = status;
  const items = await FeedItem.find(q)
    .sort({ createdAt: -1 })
    .limit(Number(limit));
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

  if (!item.extract?.text) {
    return res.status(400).json({ error: "no_extract" });
  }

  const feed = item.feedId;
  const defaults = {
    author: feed?.defaultAuthor || "Desk",
    category: feed?.defaultCategory || "General",
    geo: feed?.geo || { mode: "Global", areas: DEFAULT_GEO_AREAS },
  };

  const publishAt = toIST(item.publishedAt || new Date());

  const prompt = `
Return ONLY valid JSON in this exact schema with double quotes:

{
  "title": "<70–80 char headline>",
  "slug": "kebab-case-url-slug",
  "summary": "60–80 words.",
  "author": "Desk",
  "category": "Sports",
  "status": "Draft",
  "publishAt": "YYYY-MM-DDTHH:mm:ss+05:30",
  "imageUrl": "",
  "imagePublicId": "",
  "seo": {
    "imageAlt": "Accessible description",
    "metaTitle": "<=80 chars>",
    "metaDescription": "<=200 chars>",
    "ogImageUrl": ""
  },
  "geo": {
    "mode": "Global",
    "areas": ["country:IN"]
  },
  "tags": ["tag1","tag2","tag3"],
  "body": "≈200-word article body in plain text, with paragraph breaks."
}

Rules:
- Use the source content below. Paraphrase to avoid near-verbatim copying.
- Keep facts accurate. If unknown, omit.
- Title 70–80 chars; Summary 60–80 words; Body around 200 words (plain text).
- slug must be kebab-case from title.
- author default: "${defaults.author}"
- category default: "${defaults.category}"
- status must be "Draft".
- publishAt must be "${publishAt}" (IST).
- imageUrl and imagePublicId MUST be empty strings.
- geo default: mode "${defaults.geo.mode}", areas: ${JSON.stringify(defaults.geo.areas)}
- tags: 3–6 short tags, lowercase.
- IMPORTANT: Return JSON ONLY. No code fences.

Source:
TITLE: ${item.rawTitle || ""}
URL: ${item.link}
TEXT:
${item.extract?.text || "(missing)"}
`;

  try {
    const json = await openrouterGenerate(prompt);

    // --- normalize to Article schema (flat SEO + GEO) ---
    json.imageUrl = "";
    json.imagePublicId = "";
    json.status = "draft";

    json.publishAt = json.publishAt || publishAt;
    json.author = json.author || defaults.author;
    json.category = json.category || defaults.category;

    const seo = json.seo || {};
    json.imageAlt = seo.imageAlt || json.title || "";
    json.metaTitle = (seo.metaTitle || json.title || "").slice(0, 80);
    json.metaDesc = (seo.metaDescription || json.summary || "").slice(0, 200);
    json.ogImage = (seo.ogImageUrl || "").trim();

    const geo = json.geo || defaults.geo || { mode: "Global", areas: [] };
    json.geoMode = (geo.mode || "Global").toLowerCase();
    json.geoAreas = Array.isArray(geo.areas) ? geo.areas.map(String) : [];

    if (!Array.isArray(json.tags)) json.tags = [];
    json.tags = json.tags.map((t) => String(t).trim()).filter(Boolean);

    json.slug = slugify(json.slug || json.title || "article", {
      lower: true,
      strict: true,
    });

    item.generated = json;
    item.status = "gen";
    item.error = "";
    await item.save();

    res.json(item);
  } catch (e) {
    item.error = `generate_failed:${e.message}`;
    await item.save();
    res.status(500).json({ error: item.error });
  }
};

// POST /api/automation/items/:id/mark-ready
exports.markReady = async (req, res) => {
  const item = await FeedItem.findByIdAndUpdate(
    req.params.id,
    { status: "ready" },
    { new: true }
  );
  res.json(item);
};

// POST /api/automation/items/:id/draft
exports.createDraft = async (req, res) => {
  const item = await FeedItem.findById(req.params.id);
  if (!item) return res.status(404).json({ error: "Not found" });
  if (!item.generated) return res.status(400).json({ error: "not_generated" });

  const g = item.generated;

// If the generator did not provide an image, pick one from Cloudinary
if (!g.imagePublicId || !g.imageUrl) {
  const picked = await chooseHeroImage({
    title: g.title,
    summary: g.summary,
    category: g.category,
    tags: g.tags,
  });
  g.imagePublicId = picked.publicId;   // e.g. "news-images/default-hero"
  g.imageUrl = picked.url;             // full 1200x630 jpg URL
  // Optional SEO helpers
  if (!g.ogImage)   g.ogImage  = picked.url;
  if (!g.imageAlt)  g.imageAlt = g.title || "Article image";
}

const doc = await Article.create({
  title: g.title,
  slug: g.slug || slugify(g.title || "", { lower: true, strict: true }),

  summary: g.summary || "",
  author: g.author || "Desk",
  category: g.category || "General",

  status: "draft",
  publishAt: new Date(g.publishAt),

  // ✅ use the values selected above
  imageUrl: g.imageUrl || "",
  imagePublicId: g.imagePublicId || "",

  // SEO (flat)
  imageAlt: g.imageAlt || g.title || "",
  metaTitle: (g.metaTitle || g.title || "").slice(0, 80),
  metaDesc:  (g.metaDesc  || g.summary || "").slice(0, 200),
  ogImage:   g.ogImage || "",

  // GEO (flat)
  geoMode:  g.geoMode  || "global",
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
