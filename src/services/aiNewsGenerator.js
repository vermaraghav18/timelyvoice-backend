// backend/src/services/aiNewsGenerator.js
"use strict";

/**
 * AI News Generator Service — FIXED VERSION (works with new callOpenRouter)
 * ------------------------------------------------------------------------
 * - Uses OpenRouter to generate a JSON ARRAY of news articles.
 * - Bases content on provided RSS seeds when available.
 * - Avoids obviously old-year content.
 * - Normalizes output to match Article schema shape.
 */

const slugify = require("slugify");
const { callOpenRouterText, safeParseJSON } = require("./openrouter.service");

// Base model for automation (can be overridden via env)
const DEFAULT_AUTOMATION_MODEL =
  process.env.OPENROUTER_MODEL_AUTONEWS || "openai/gpt-4o-mini";

// How many articles per batch by default
const DEFAULT_BATCH_SIZE = parseInt(
  process.env.AI_AUTOMATION_BATCH_SIZE || "10",
  10
);

// Max tokens for a batch completion
const MAX_TOKENS_AUTONEWS = parseInt(
  process.env.AI_AUTOMATION_MAX_TOKENS || "4000",
  10
);

// Simple category normalization
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

function normalizeCategory(raw) {
  const s = String(raw || "").trim();
  if (!s) return "World";
  const found = ALLOWED_CATEGORIES.find(
    (c) => c.toLowerCase() === s.toLowerCase()
  );
  return found || "World";
}

// Generate a safe slug from the title
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

/**
 * Normalize a raw article from the model into something
 * that matches the Article schema shape as closely as possible.
 *
 * defaultPublishAt: Date to use when model's publishAt is missing/wrong.
 */
function normalizeOne(raw, index, { defaultPublishAt } = {}) {
  if (!raw || typeof raw !== "object") return null;

  const title = String(raw.title || "").trim();
  const body = String(raw.body || "").trim();
  if (!title || !body) return null; // must have both

  const summary = String(raw.summary || "").trim();
  const category = normalizeCategory(raw.category);

  // We DO NOT trust model's publishAt; we override with our own
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
          raw.tags
            .map((t) => String(t || "").trim())
            .filter(Boolean)
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

  // ---- GEO NORMALIZATION (critical for Mongo enum) ----
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
    // Core Article fields
    title,
    slug,
    summary,
    author: raw.author || "Desk",
    category,
    body,

    // Status & schedule — keep drafts by default
    status: "draft",
    publishAt: Number.isNaN(publishAt.getTime()) ? new Date() : publishAt,

    // Images (image picker will usually fill these later)
    imageUrl: raw.imageUrl || "",
    imagePublicId: raw.imagePublicId || "",

    // Nested SEO object
    seo: {
      imageAlt,
      metaTitle,
      metaDescription,
      ogImageUrl,
    },

    // Geo targeting (nested object)
    geo: {
      mode: normalizedGeoMode,
      areas: geoAreas,
    },

    // Tags
    tags,

    // Compatibility flat fields (some old code expects these)
    imageAlt,
    metaTitle,
    metaDesc: metaDescription,
    ogImage: ogImageUrl,
    geoMode: normalizedGeoMode, // ✅ always lowercase & enum-safe
    geoAreas,                   // ✅ always an array
  };
}

/**
 * Turn whatever the model returned into an array of article-like objects.
 * json can be:
 *  - an array
 *  - { articles: [...] }
 *  - an object with numeric keys
 *  - a single object
 */
function coerceArticlesArray(json) {
  if (!json) return [];

  // CASE A: Already an array
  if (Array.isArray(json)) return json;

  // CASE B: { articles: [...] }
  if (Array.isArray(json.articles)) {
    return json.articles;
  }

  // CASE C: { "0": {...}, "1": {...} }
  if (typeof json === "object") {
    const keys = Object.keys(json);
    const numericKeys = keys.filter((k) => !Number.isNaN(Number(k)));

    if (numericKeys.length === keys.length && numericKeys.length > 0) {
      return numericKeys
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => json[k]);
    }

    // CASE D: Single object — wrap in array
    return [json];
  }

  return [];
}

/**
 * generateNewsBatch
 * -----------------
 * Params:
 *   - count: how many articles to generate (1–20)
 *   - categories: optional array of category names
 *   - seeds: array of RSS seed objects from liveNewsIngestor.fetchLiveSeeds()
 *   - trendingBias: optional boolean to slightly increase creativity
 *   - mode: reserved for future switches
 *
 * Returns:
 *   { raw, normalized }
 */
async function generateNewsBatch({
  count,
  categories,
  seeds = [],
  trendingBias,
  mode, // eslint-disable-line no-unused-vars
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

  // Build seed block if provided
  let seedBlock = "";
  let seedNote = "";
  let seedDates = [];

  if (Array.isArray(seeds) && seeds.length) {
    const limitedSeeds = seeds.slice(0, n);
    seedDates = limitedSeeds.map((s) =>
      s.publishedAt instanceof Date ? s.publishedAt : new Date(s.publishedAt)
    );

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
You are given a list of LIVE RSS stories (title + short summary + link + publishedAt).
You MUST base each article ONLY on these seeds. Do NOT invent topics that are not in the seed list.
Use the seed’s timestamp as a guide. Today is ${todayISO}.
Do NOT write about events from 2023 or any earlier year unless that year is explicitly present in the seed text.
If a year is not mentioned in the seed, assume the event is occurring THIS YEAR (${todayISO.slice(
      0,
      4
    )}).
`.trim();
  } else {
    seedNote = `
You do NOT have direct access to live data.
When no RSS seeds are provided, write plausible current news articles appropriate for today (${todayISO}) on an Indian news site.
Avoid referring to old years like 2023 unless absolutely necessary.
`.trim();
  }

  const sysMessage = `
You are an experienced news editor and writer for "The Timely Voice".
Generate ORIGINAL news articles in a neutral, factual, reporter-style voice.

${seedNote}

Return STRICTLY a valid JSON array of ${n} objects.
Each object MUST have exactly these fields and types:

{
  "title": "string",
  "slug": "kebab-case-url-slug",
  "summary": "60-90 word summary",
  "author": "Desk",
  "category": "one of: ${ALLOWED_CATEGORIES.join(", ")}",
  "status": "Published",
  "publishAt": "ISO 8601 datetime string in Asia/Kolkata timezone",
  "imageUrl": "",
  "imagePublicId": "",
  "seo": {
    "imageAlt": "short accessible alt text for hero image (even if imageUrl is empty)",
    "metaTitle": "<=80 characters",
    "metaDescription": "<=200 characters",
    "ogImageUrl": ""
  },
  "geo": {
    "mode": "Global",
    "areas": ["country:IN"]
  },
  "tags": ["tag1", "tag2"],
  "body": "600-900 word article body in plain text with paragraph breaks."
}

Hard rules:
- DO NOT wrap the JSON in backticks, markdown, or any extra text.
- DO NOT include comments or explanations. ONLY the JSON array.
- NEVER include phrases like "As of 2023" or obviously outdated timings unless explicitly present in the RSS seed.
- The "publishAt" field you output should be within the last 24 hours relative to now (${now.toISOString()}).
- Always keep body factual and news-style, not opinionated essays.
`.trim();

  let userMessage;
  if (seedBlock) {
    userMessage = `
Here are the live RSS seeds you MUST rewrite into full articles.
Create EXACTLY one full article for each listed seed, preserving the core topic and recency.

=== LIVE RSS SEEDS ===
${seedBlock}
`.trim();
  } else {
    userMessage = `
No RSS seeds were provided.
Generate ${n} realistic, current news articles suitable for an Indian news website today.
Follow the JSON format exactly.
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
      console.error(
        "[aiNewsGenerator] Empty text from OpenRouterText result:",
        JSON.stringify(result, null, 2).slice(0, 500)
      );
      return { raw: null, normalized: [] };
    }
  } catch (err) {
    console.error(
      "[aiNewsGenerator] OpenRouter call failed:",
      err.message || err
    );
    return { raw: null, normalized: [] };
  }

  let json;
  try {
    json = safeParseJSON(text);
  } catch (err) {
    console.error(
      "[aiNewsGenerator] Failed to parse model JSON:",
      err.message || err,
      "raw content preview:",
      text.slice(0, 400)
    );
    return { raw: text, normalized: [] };
  }

  const rawArticles = coerceArticlesArray(json);

  const normalized = rawArticles
    .map((raw, idx) =>
      normalizeOne(raw, idx, { defaultPublishAt: seedDates[idx] })
    )
    .filter(Boolean);

  if (!normalized.length) {
    console.warn(
      "[aiNewsGenerator] No normalized articles produced from model output."
    );
  }

  return {
    raw: json,
    normalized,
  };
}

module.exports = {
  generateNewsBatch,
};
