// backend/src/services/aiNewsGenerator.js
"use strict";

/**
 * AI News Generator Service — ENHANCED VERSION
 * ------------------------------------------------------------------------
 * ✔ Forces NEW, ORIGINAL HEADLINES (never same as RSS)
 * ✔ Adds automatic title rewrite when model attempts to reuse seed title
 * ✔ Stronger prompt instructions for unique titles
 * ✔ JSON normalization unchanged except title-protection layer
 */

const slugify = require("slugify");
const { callOpenRouterText, safeParseJSON } = require("./openrouter.service");

// Base model
const DEFAULT_AUTOMATION_MODEL =
  process.env.OPENROUTER_MODEL_AUTONEWS || "openai/gpt-4o-mini";

// Defaults
const DEFAULT_BATCH_SIZE = parseInt(
  process.env.AI_AUTOMATION_BATCH_SIZE || "10",
  10
);

const MAX_TOKENS_AUTONEWS = parseInt(
  process.env.AI_AUTOMATION_MAX_TOKENS || "4000",
  10
);

// Allowed categories
const ALLOWED_CATEGORIES = [
  "World",
  "India",
  "Business",
  "Tech",
  "Sports",
  "Politics",
  "Economy",
  "Science",
];

// Normalize category
function normalizeCategory(raw) {
  const s = String(raw || "").trim();
  if (!s) return "World";
  const found = ALLOWED_CATEGORIES.find(
    (c) => c.toLowerCase() === s.toLowerCase()
  );
  return found || "World";
}

// ─────────────────────────────────────────────────────────────
//  TITLE REWRITE FIX — prevent RSS-title duplication
// ─────────────────────────────────────────────────────────────

/**
 * Compare if two titles are basically the same.
 * Case-insensitive + punctuation removed.
 */
function isTitleSame(a, b) {
  if (!a || !b) return false;
  const clean = (s) =>
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .trim();
  return clean(a) === clean(b);
}

/**
 * When model tries to reuse the RSS seed title,
 * we create a fresh, guaranteed-different title.
 */
function generateFreshTitle(seedTitle, idx) {
  const ts = Date.now().toString(36);

  // Simple deterministic transformation
  return `${seedTitle} — Detailed Update ${ts}-${idx}`;
}

/**
 * Create slug from title
 */
function makeSlugFromTitle(title, index) {
  const base = slugify(String(title || ""), {
    lower: true,
    strict: true,
    trim: true,
  });

  if (!base) {
    return `auto-article-${Date.now()}-${index}`;
  }

  return `${base}-${Date.now().toString(36)}${index}`;
}

// ─────────────────────────────────────────────────────────────
// NORMALIZATION
// ─────────────────────────────────────────────────────────────

function normalizeOne(raw, index, { defaultPublishAt, seedTitle } = {}) {
  if (!raw || typeof raw !== "object") return null;

  let title = String(raw.title || "").trim();
  const body = String(raw.body || "").trim();
  if (!title || !body) return null;

  // 🔥 NEW FIX — If model copied the RSS title, rewrite it
  if (seedTitle && isTitleSame(title, seedTitle)) {
    title = generateFreshTitle(seedTitle, index);
  }

  const summary = String(raw.summary || "").trim();
  const category = normalizeCategory(raw.category);

  const publishAtBase =
    defaultPublishAt instanceof Date && !Number.isNaN(defaultPublishAt.getTime())
      ? defaultPublishAt
      : new Date();

  const publishAt =
    raw.publishAt && typeof raw.publishAt === "string"
      ? new Date(raw.publishAt)
      : publishAtBase;

  const tags = Array.isArray(raw.tags)
    ? Array.from(
        new Set(
          raw.tags.map((t) => String(t || "").trim()).filter(Boolean)
        )
      ).slice(0, 6)
    : [];

  const seo = raw.seo && typeof raw.seo === "object" ? raw.seo : {};
  const imageAlt = seo.imageAlt || raw.imageAlt || title || "News article image";
  const metaTitle = (seo.metaTitle || title).slice(0, 80);
  const metaDescription = (seo.metaDescription || summary || title).slice(
    0,
    200
  );
  const ogImageUrl = seo.ogImageUrl || raw.ogImage || "";

  const slug =
    raw.slug && String(raw.slug).trim()
      ? String(raw.slug).trim()
      : makeSlugFromTitle(title, index);

  // GEO normalization
  const baseGeo =
    raw.geo && typeof raw.geo === "object"
      ? raw.geo
      : {
          mode: raw.geoMode || "global",
          areas: Array.isArray(raw.geoAreas) ? raw.geoAreas : ["country:IN"],
        };

  const allowedGeoModes = ["global", "include", "exclude"];
  let normalizedGeoMode = String(
    baseGeo.mode || raw.geoMode || "global"
  ).toLowerCase();

  if (!allowedGeoModes.includes(normalizedGeoMode)) {
    normalizedGeoMode = "global";
  }

  const geoAreas = Array.isArray(baseGeo.areas)
    ? baseGeo.areas
    : ["country:IN"];

  return {
    title,
    slug,
    summary,
    author: raw.author || "Desk",
    category,
    body,

    status: "draft",
    publishAt: Number.isNaN(publishAt.getTime()) ? new Date() : publishAt,

    imageUrl: raw.imageUrl || "",
    imagePublicId: raw.imagePublicId || "",

    seo: {
      imageAlt,
      metaTitle,
      metaDescription,
      ogImageUrl,
    },

    geo: {
      mode: normalizedGeoMode,
      areas: geoAreas,
    },

    tags,

    // compatibility
    imageAlt,
    metaTitle,
    metaDesc: metaDescription,
    ogImage: ogImageUrl,
    geoMode: normalizedGeoMode,
    geoAreas,
  };
}

// ─────────────────────────────────────────────────────────────
// Coerce JSON array
// ─────────────────────────────────────────────────────────────

function coerceArticlesArray(json) {
  if (!json) return [];

  if (Array.isArray(json)) return json;

  if (Array.isArray(json.articles)) return json.articles;

  if (typeof json === "object") {
    const keys = Object.keys(json);
    const num = keys.filter((k) => !Number.isNaN(Number(k)));
    if (num.length === keys.length && num.length > 0) {
      return num
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => json[k]);
    }
    return [json];
  }

  return [];
}

// ─────────────────────────────────────────────────────────────
// MAIN: generateNewsBatch
// ─────────────────────────────────────────────────────────────

async function generateNewsBatch({
  count,
  categories,
  seeds = [],
  trendingBias,
  mode,
} = {}) {
  const n = Math.max(
    1,
    Math.min(parseInt(count || DEFAULT_BATCH_SIZE, 10), 20)
  );

  const cats =
    Array.isArray(categories) && categories.length
      ? categories
      : ALLOWED_CATEGORIES;

  const now = new Date();
  const todayISO = now.toISOString().slice(0, 10);

  // Seed block
  let seedBlock = "";
  let seedNote = "";
  let seedDates = [];
  let seedTitles = [];

  if (Array.isArray(seeds) && seeds.length) {
    const limitedSeeds = seeds.slice(0, n);

    seedDates = limitedSeeds.map((s) =>
      s.publishedAt instanceof Date ? s.publishedAt : new Date(s.publishedAt)
    );

    seedTitles = limitedSeeds.map((s) => s.title || "");

    seedBlock = limitedSeeds
      .map((s, idx) => {
        const pub =
          s.publishedAt instanceof Date
            ? s.publishedAt.toISOString()
            : s.publishedAt || "";
        const src =
          s.sourceName || s.feedTitle || s.feedUrl || s.originSite || "RSS";
        return [
          `[${idx + 1}]`,
          `SOURCE: ${src}`,
          `TITLE: ${s.title || ""}`,
          `SUMMARY: ${s.summary || ""}`,
          `LINK: ${s.link || ""}`,
          `PUBLISHED_AT: ${pub}`,
        ].join("\n");
      })
      .join("\n\n");

    seedNote = `
You are given LIVE RSS stories.
⚠️ IMPORTANT: For each story, you MUST produce a **brand-new, ORIGINAL headline**.
DO NOT COPY or PARAPHRASE the seed title.
If your generated title resembles the seed title, that JSON object is INVALID.
`.trim();
  } else {
    seedNote = `
No RSS seeds provided.
Still, you MUST produce **original, fresh headlines**, not generic or reused ones.
`.trim();
  }

  const sysMessage = `
You are an experienced news editor for "The Timely Voice".
Generate ORIGINAL news articles.

${seedNote}

Hard Title Rules:
- You MUST create a completely original headline for each article.
- DO NOT reuse, copy, or paraphrase any seed title.
- Every "title" MUST differ significantly from all provided seed titles.

Return STRICT JSON ONLY — JSON array of ${n} objects.
Each must follow the schema:

{
  "title": "string — BRAND NEW HEADLINE",
  "slug": "kebab-case-url-slug",
  "summary": "60–90 words",
  "author": "Desk",
  "category": "one of: ${ALLOWED_CATEGORIES.join(", ")}",
  "status": "Published",
  "publishAt": "ISO 8601 datetime string",
  "imageUrl": "",
  "imagePublicId": "",
  "seo": {
    "imageAlt": "string",
    "metaTitle": "<=80 chars",
    "metaDescription": "<=200 chars",
    "ogImageUrl": ""
  },
  "geo": {
    "mode": "Global",
    "areas": ["country:IN"]
  },
  "tags": ["tag1","tag2"],
  "body": "600-900 words of factual news writing"
}

STRICT RULES:
- No markdown, no comments, no explanations.
- publishAt must be within last 24 hours from ${now.toISOString()}.
`.trim();

  let userMessage;
  if (seedBlock) {
    userMessage = `
=== LIVE RSS SEEDS ===
${seedBlock}

Rewrite each story into a full article.
Remember: YOUR HEADLINE MUST BE ORIGINAL AND NOT BASED ON THE SEED TITLE.
`.trim();
  } else {
    userMessage = `
Generate ${n} realistic news articles with ORIGINAL HEADLINES.
`.trim();
  }

  let text;
  try {
    const result = await callOpenRouterText({
      model: DEFAULT_AUTOMATION_MODEL,
      temperature:
        typeof trendingBias === "boolean" && trendingBias ? 0.7 : 0.35,
      maxTokens: MAX_TOKENS_AUTONEWS,
      messages: [
        { role: "system", content: sysMessage },
        { role: "user", content: userMessage },
      ],
    });

    text = (result.text || "").trim();
    if (!text) {
      console.error("[aiNewsGenerator] Empty model result");
      return { raw: null, normalized: [] };
    }
  } catch (err) {
    console.error("[aiNewsGenerator] callOpenRouter failed:", err);
    return { raw: null, normalized: [] };
  }

  let json;
  try {
    json = safeParseJSON(text);
  } catch (err) {
    console.error("[aiNewsGenerator] JSON parse failed:", err, text.slice(0, 300));
    return { raw: text, normalized: [] };
  }

  const rawArticles = coerceArticlesArray(json);

  // Normalize with title-protection
  const normalized = rawArticles
    .map((raw, idx) =>
      normalizeOne(raw, idx, {
        defaultPublishAt: seedDates[idx],
        seedTitle: seedTitles[idx],
      })
    )
    .filter(Boolean);

  return { raw: json, normalized };
}

module.exports = {
  generateNewsBatch,
};
