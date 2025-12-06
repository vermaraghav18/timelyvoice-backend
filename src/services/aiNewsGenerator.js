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
async function generateNewsBatch({ count, categories } = {}) {
  const n = Math.max(
    1,
    Math.min(parseInt(count || DEFAULT_BATCH_SIZE, 10), 20)
  );

  const cats =
    Array.isArray(categories) && categories.length ? categories : ALLOWED_CATEGORIES;

  const sysMessage = `
You are an experienced news editor and writer for "The Timely Voice".
Generate ORIGINAL, factual news articles based on real-world, recent events.
Each article must be neutral, concise, and SEO-friendly.
Always respond ONLY with strict JSON, no extra text.`;

  const userMessage = `
Generate ${n} different news articles as a single JSON object.

REQUIREMENTS:
- Topics spread across categories: ${cats.join(
    ", "
  )} (but you may reuse if needed).
- Each article body ~600–900 words, plain text, with paragraph breaks.
- Strictly avoid copying sentences; write in your own words.
- Indian audience primary, but include World + Business + Tech as needed.

OUTPUT FORMAT (single JSON object):

{
  "articles": [
    {
      "title": "Headline 70–80 characters",
      "slug": "kebab-case-url-slug",
      "summary": "60–80 word summary of the article.",
      "author": "Desk",
      "category": "World | India | Business | Tech | Sports | Politics | Economy | Science",
      "publishAt": "ISO 8601 datetime string (e.g. 2025-12-05T09:30:00+05:30)",
      "tags": ["short", "topic", "keywords"],
      "seo": {
        "imageAlt": "Accessible description of the main photo",
        "metaTitle": "<=80 character SEO title",
        "metaDescription": "<=200 character SEO description",
        "ogImageUrl": ""
      },
      "body": "600-900 word plain-text body with paragraphs."
    }
  ]
}`;

  const messages = [
    { role: "system", content: sysMessage },
    { role: "user", content: userMessage },
  ];

  const json = await callOpenRouter({
    messages,
    model: AUTOMATION_MODEL, // 🔒 force GPT-4o-mini for automation
    apiKey:
      (process.env.OPENROUTER_API_KEY_AUTOMATION ||
        process.env.OPENROUTER_API_KEY ||
        "").trim(),
    max_tokens: n * 2200, // safe upper bound
  });

  // We expect { articles: [...] } but be defensive:
  let rawArticles = [];
  if (Array.isArray(json?.articles)) {
    rawArticles = json.articles;
  } else if (Array.isArray(json)) {
    rawArticles = json;
  } else if (json && typeof json === "object") {
    // Maybe the model returned { data: [...] }
    if (Array.isArray(json.data)) rawArticles = json.data;
  }

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
