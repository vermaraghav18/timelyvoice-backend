// backend/src/services/aiNewsGenerator.js
"use strict";

/**
 * AI News Generator Service
 * -------------------------
 * This service calls OpenRouter and asks it to generate
 * a batch of news articles in JSON format.
 *
 * It returns an array of *normalized* article objects
 * ready to be passed into Article.create().
 */

const slugify = require("slugify");
const { callOpenRouter } = require("./openrouter.service");

// Hard-wire automation model to a JSON-safe model
const AUTOMATION_MODEL = "openai/gpt-4o-mini";

// How many articles per batch by default
const DEFAULT_BATCH_SIZE = parseInt(
  process.env.AI_AUTOMATION_BATCH_SIZE || "10",
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
  // Try exact match ignoring case
  const found = ALLOWED_CATEGORIES.find(
    (c) => c.toLowerCase() === s.toLowerCase()
  );
  return found || "World";
}

// Generate a safe slug from the title
function makeSlugFromTitle(title, index) {
  const base = slugify(String(title || ""), {
    lower: true,
    strict: true, // only a-z0-9 and hyphen
    trim: true,
  });

  if (!base) {
    return `auto-article-${Date.now()}-${index}`;
  }

  return `${base}-${Date.now().toString(36)}${index}`;
}

/**
 * Normalize a raw article from the model into something
 * that matches the Article schema shape.
 */
function normalizeOne(raw, index) {
  if (!raw || typeof raw !== "object") return null;

  const title = String(raw.title || "").trim();
  const body = String(raw.body || "").trim();

  if (!title || !body) return null; // must have both

  const summary = String(raw.summary || "").trim();

  const category = normalizeCategory(raw.category);
  const publishAtInput = raw.publishAt || new Date().toISOString();
  const publishAt = new Date(publishAtInput);

  const tags = Array.isArray(raw.tags)
    ? Array.from(
        new Set(
          raw.tags
            .map((t) => String(t || "").trim())
            .filter(Boolean)
        )
      ).slice(0, 6)
    : [];

  // SEO object (optional in model output)
  const seo = raw.seo || {};
  const imageAlt =
    seo.imageAlt || raw.imageAlt || title || "News article image";

  const metaTitle = (seo.metaTitle || title).slice(0, 80);
  const metaDesc = (seo.metaDescription || summary).slice(0, 200);

  const slug =
    raw.slug && String(raw.slug).trim()
      ? String(raw.slug).trim()
      : makeSlugFromTitle(title, index);

  return {
    // core
    title,
    slug,
    summary,
    author: raw.author || "Desk",
    category,
    body,

    // scheduling
    status: "draft",
    publishAt: isNaN(publishAt.getTime()) ? new Date() : publishAt,

    // geo (optional)
    geoMode: raw.geoMode || (raw.geo && raw.geo.mode) || "global",
    geoAreas:
      (raw.geo && Array.isArray(raw.geo.areas) && raw.geo.areas) ||
      raw.geoAreas ||
      [],

    // images (we usually let the image picker fill these later)
    imageUrl: raw.imageUrl || "",
    imagePublicId: raw.imagePublicId || "",
    imageAlt,
    ogImage: seo.ogImageUrl || raw.ogImage || "",

    // SEO fields
    metaTitle,
    metaDesc,

    // tags
    tags,
  };
}

/**
 * generateNewsBatch
 * -----------------
 * count: how many articles to generate (1–20)
 * categories: optional array of category names
 *
 * Returns: { raw, normalized }
 *  - raw:       whatever JSON the model returned
 *  - normalized: array of payloads ready for Article.create()
 */
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

  // Build seed block if provided
  let seedBlock = "";
  let seedNote = "";
  if (Array.isArray(seeds) && seeds.length) {
    const limitedSeeds = seeds.slice(0, n); // we only need as many as we’re going to generate
    seedBlock = limitedSeeds
      .map((s, idx) => {
        const pub =
          s.publishedAt instanceof Date
            ? s.publishedAt.toISOString()
            : s.publishedAt || "";
        return [
          `[${idx + 1}]`,
          `SOURCE: ${s.sourceName || "RSS"}`,
          `TITLE: ${s.title || ""}`,
          `SUMMARY: ${s.summary || s.description || ""}`,
          `LINK: ${s.link || ""}`,
          `PUBLISHED_AT: ${pub}`,
        ].join("\n");
      })
      .join("\n\n");

    seedNote = `
You are given a list of LIVE RSS stories (title + short summary + link + publishedAt).
You MUST base each article ONLY on these seeds. Do NOT invent topics that are not in the seed list.
Use the seed’s timestamp as a guide. Today is ${now.toISOString().slice(0, 10)}. 
Do NOT write about events from 2023 or any year far in the past unless explicitly contained in the seed text.
`.trim();
  } else {
    seedNote = `
You do NOT have direct access to live data. 
When no RSS seeds are provided, stay as close as possible to the present date (${now.toISOString().slice(
      0,
      10
    )}) and avoid referring to old years like 2023 unless clearly necessary.
`.trim();
  }

  const sysMessage = `
You are an experienced news editor and writer for "The Timely Voice".
Generate ORIGINAL, factual-style news articles.

${seedNote}

Return STRICTLY a valid JSON array of ${n} objects.
Each object MUST have these fields:

{
  "title": "string",
  "slug": "kebab-case-url-slug",
  "summary": "60-90 word summary",
  "author": "Desk",
  "category": "one of: ${ALLOWED_CATEGORIES.join(", ")}",
  "status": "Published",
  "publishAt": "ISO 8601 datetime in Asia/Kolkata timezone",
  "imageUrl": "",
  "imagePublicId": "",
  "seo": {
    "imageAlt": "short accessible alt text for hero image (even if empty imageUrl)",
    "metaTitle": "≤80 chars",
    "metaDescription": "≤200 chars",
    "ogImageUrl": ""
  },
  "geo": {
    "mode": "Global",
    "areas": ["country:IN"]
  },
  "tags": ["tag1", "tag2"],
  "body": "600-900 word article body in plain text with paragraph breaks."
}

Rules:
- NEVER include phrases like "As of 2023" or clearly outdated timestamps unless explicitly in the RSS seed.
- The "publishAt" field should be within the last 24 hours relative to the time now (${now.toISOString()}).
- Do not copy any text verbatim from external sources; always rewrite.
`.trim();

  let userMessage;
  if (seedBlock) {
    userMessage = `
Here are the live RSS seeds you must rewrite. 
Create exactly one full article for each listed seed, keeping topical alignment with the original story.

=== LIVE RSS SEEDS ===
${seedBlock}
`.trim();
  } else {
    // Fallback if no seeds were available: generic prompt but with strict recency rules.
    userMessage = `
No RSS seeds were provided.
Generate ${n} news articles that could realistically appear on a current Indian news site today.
Follow the JSON format exactly.
`.trim();
  }

  const json = await callOpenRouter({
    messages: [
      { role: "system", content: sysMessage },
      { role: "user", content: userMessage },
    ],
    model: process.env.OPENROUTER_MODEL_AUTONEWS || DEFAULT_MODEL,
    temperature: typeof trendingBias === "boolean" && trendingBias ? 0.7 : 0.35,
    max_tokens: MAX_TOKENS_AUTONEWS || 4000,
  });

  // Existing logic that parses + normalizes
  const rawArticles = Array.isArray(json) ? json : [];
  const normalized = rawArticles
    .map((raw, idx) => normalizeOne(raw, idx))
    .filter(Boolean);

  return {
    raw: json,
    normalized,
  };
}

module.exports = {
  generateNewsBatch,
};
