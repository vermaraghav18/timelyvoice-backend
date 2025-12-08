// backend/src/services/aiNewsGenerator.js
"use strict";

/**
 * AI News Generator Service
 * -------------------------
 * Calls OpenRouter and asks it to generate
 * a batch of news articles in JSON format.
 *
 * LIVE-FIRST VERSION:
 * - Tries to fetch real news seeds via liveNewsIngestor.
 * - If seeds exist, rewrites EACH seed into a fresh article (1:1).
 * - If no seeds, falls back to synthetic topic-based generation.
 *
 * Returns an array of *normalized* article objects
 * ready to be passed into Article.create().
 */

const slugify = require("slugify");
const { callOpenRouter } = require("./openrouter.service");
const { fetchLiveSeeds } = require("./liveNewsIngestor");

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

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function stripHtml(s = "") {
  return String(s).replace(/<[^>]*>/g, " ");
}
function estimateWordCount(text = "") {
  const plain = stripHtml(text).replace(/\s+/g, " ");
  if (!plain.trim()) return 0;
  return plain.trim().split(" ").length;
}

/**
 * Phase 10:
 * - Do NOT drop articles for being "too short".
 * - Only normalise and log if something is tiny.
 */
function softFilterArticles(rawList = []) {
  const normalizedOk = [];

  rawList.forEach((raw, idx) => {
    const norm = normalizeOne(raw, idx);
    if (!norm) return; // malformed / missing title/body

    const wc = estimateWordCount(norm.body);
    if (wc < 150) {
      console.warn(
        "[aiNewsGenerator] low-length article index=%s wordCount=%s (keeping anyway)",
        idx,
        wc
      );
    }

    normalizedOk.push(norm);
  });

  return normalizedOk;
}

/**
 * Normalise a raw article from the model into something
 * that matches the Article schema shape.
 */
function normalizeOne(raw, index) {
  if (!raw || typeof raw !== "object") return null;

  const title = String(raw.title || "").trim();
  const body = String(raw.body || "").trim();

  if (!title || !body) return null;

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
    title,
    slug,
    summary,
    author: raw.author || "Desk",
    category,
    body,

    status: "draft",
    publishAt: isNaN(publishAt.getTime()) ? new Date() : publishAt,

    geoMode: raw.geoMode || (raw.geo && raw.geo.mode) || "global",
    geoAreas:
      (raw.geo && Array.isArray(raw.geo.areas) && raw.geo.areas) ||
      raw.geoAreas ||
      [],

    imageUrl: raw.imageUrl || "",
    imagePublicId: raw.imagePublicId || "",
    imageAlt,
    ogImage: seo.ogImageUrl || raw.ogImage || "",

    metaTitle,
    metaDesc,

    tags,
  };
}

/**
 * generateNewsBatch
 * -----------------
 * count:       how many articles to generate (1–20)
 * categories:  optional array of category names (used mainly as hints)
 * mode:        "standard" | "breaking"  (tone)
 * trendingBias:boolean                 (only really used in fallback)
 *
 * LIVE-FIRST STRATEGY:
 *  1) Try to fetch live seeds from liveNewsIngestor.
 *  2) If seeds exist, rewrite each seed into a fresh article (1:1).
 *  3) If no seeds, fall back to synthetic generation from general topics.
 *
 * Returns: { raw, normalized }
 */
async function generateNewsBatch({
  count,
  categories,
  mode = "standard",
  trendingBias = true,
} = {}) {
  const requestedCount = Math.max(
    1,
    Math.min(parseInt(count || DEFAULT_BATCH_SIZE, 10), 20)
  );

  const cats =
    Array.isArray(categories) && categories.length
      ? categories
      : ALLOWED_CATEGORIES;

  // Use server time to anchor "current year" for the model
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const currentYear = now.getFullYear();

  const modePhrase =
    mode === "breaking"
      ? "Use a clear, time-sensitive headline and lede that reflect developing or breaking news, but still write one coherent article (not a live blog)."
      : "Use a calm, standard news-reporting tone similar to professional wire services (Reuters, PTI, AP).";

  const trendingPhrase = trendingBias
    ? `Imagine you are aggregating from multiple sources: Indian news outlets, government press releases, reputable global media and social feeds (for example X). Strongly prefer topics that are high-impact or widely discussed in roughly the last 24–72 hours. If you are unsure of very fresh details, keep language general instead of inventing specific numbers or quotes.`
    : `You may also include slower-moving, background or explainer pieces when appropriate, but keep them connected to real events.`;

  const diversityPhrase = `
- In EACH batch, the articles must cover DIFFERENT main subjects. Do not write multiple pieces about the same thing (for example, do not generate more than one article about monthly inflation or RBI rates in the same batch).
- Think in "beats" and rotate them:
  * India politics and governance (elections, parliament, cabinet, parties)
  * India economy & business (GDP, RBI, markets, major companies)
  * India society & infrastructure (education, health, transport, urban issues)
  * World geopolitics and conflicts
  * World economy/markets affecting India
  * Technology & digital policy
  * Environment, climate, energy
  * Sports or culture (optional, but allowed)
- For single-article batches, randomly pick one of these beats rather than always choosing inflation or RBI.`;

  // ────────────────────────────────────────────────────────────────
  // 1) LIVE SEEDS: try to fetch real headlines first
  // ────────────────────────────────────────────────────────────────
  let seeds = [];
  try {
    seeds = await fetchLiveSeeds(requestedCount);
  } catch (err) {
    console.error(
      "[aiNewsGenerator] fetchLiveSeeds failed, falling back:",
      err?.message || err
    );
  }

  if (seeds && seeds.length) {
    // LIVE mode: one article per seed, strict rewrite
    const n = seeds.length;

    const seedsForPrompt = seeds
      .map((s, idx) => {
        return [
          `SEED #${idx + 1}:`,
          `- title: ${s.title}`,
          `- summary: ${s.summary || "(no summary, use your own framing)"}`,
          `- sourceUrl: ${s.link || "(unknown)"}`,
          `- categoryHint: ${s.category || "World"}`,
          `- publishedAt: ${s.publishedAt?.toISOString?.() || s.publishedAt}`,
        ].join("\n");
      })
      .join("\n\n");

    const sysMessage = `
You are an experienced human news editor writing for the Indian digital publication "The Timely Voice".

Assume today's date on your desk is ${todayStr} (year ${currentYear}).

Your job in LIVE mode:
- For EACH real news seed we provide, write ONE fully original news article (1:1 mapping).
- Use the seed only as factual basis for the event. Do NOT copy any sentences or phrases.
- Maintain a neutral, factual tone similar to Reuters, PTI, AP.
- Audience: primarily Indian readers.
- You MUST return only strict JSON. Do not include commentary, markdown, or explanations outside the JSON structure.

Important rules:
- MAIN events must be set in the CURRENT YEAR ${currentYear}.
- If you are not sure about a very specific number or quote, keep wording general instead of inventing exact figures.
- Do NOT invent precise fake quotes or attributions. Prefer neutral formulations such as "officials said" or "analysts noted" without quoted speech.
- Each article must read as if it could appear on a professional news website.`;

    const userMessage = `
We fetched ${n} REAL news items ("seeds") from live sources (Indian + international + government feeds).

For EACH seed, generate ONE fully original news article, in the SAME ORDER, so that:

  article[0] corresponds to SEED #1
  article[1] corresponds to SEED #2
  ...
  article[${n - 1}] corresponds to SEED #${n}

Your article MUST:
- Cover the SAME event as the seed, but in your own words and structure.
- Include enough background and context for an Indian digital-news audience.
- Aim for 600–900 words per body, but DO NOT fail or stop if you produce fewer words. Shorter pieces are acceptable.
- Use a clear, informative headline (70–80 characters) that describes the main event.
- First paragraph should contain the key "who / what / where / when".
- Use a neutral, factual tone.
- Tone mode: ${modePhrase}

Seed items (read carefully, they are the base events):

${seedsForPrompt}

OUTPUT REQUIREMENTS:
- You MUST output a single JSON object with an "articles" array.
- The number of articles MUST equal ${n}.
- For each article, fill these fields:

{
  "articles": [
    {
      "title": "Headline 70–80 characters",
      "slug": "kebab-case-url-slug",
      "summary": "60–80 word summary of the article.",
      "author": "Desk",
      "category": "World | India | Business | Tech | Sports | Politics | Economy | Science",
      "publishAt": "ISO 8601 datetime string (e.g. ${currentYear}-12-07T09:30:00+05:30)",
      "tags": ["short", "topic", "keywords"],
      "seo": {
        "imageAlt": "Accessible description of the main photo",
        "metaTitle": "<=80 character SEO title",
        "metaDescription": "<=200 character SEO description",
        "ogImageUrl": ""
      },
      "body": "Plain-text body with paragraph breaks. Aim for 600–900 words, but shorter is allowed."
    }
  ]
}

IMPORTANT:
- "category" should be chosen to best match the event and can be: ${ALLOWED_CATEGORIES.join(
      " | "
    )}.
- Do NOT include any extra keys at the top-level of the JSON other than "articles".
- Do NOT include any text before or after the JSON.`;

    const messages = [
      { role: "system", content: sysMessage },
      { role: "user", content: userMessage },
    ];

    const json = await callOpenRouter({
      messages,
      model: AUTOMATION_MODEL,
      apiKey:
        (process.env.OPENROUTER_API_KEY_AUTOMATION ||
          process.env.OPENROUTER_API_KEY ||
          "").trim(),
      max_tokens: n * 2200,
      temperature: 0.7, // slightly lower: we want faithful rewrites, not wild deviations
    });

    let rawArticles = [];
    if (Array.isArray(json?.articles)) {
      rawArticles = json.articles;
    } else if (Array.isArray(json)) {
      rawArticles = json;
    } else if (json && typeof json === "object" && Array.isArray(json.data)) {
      rawArticles = json.data;
    }

    const normalized = softFilterArticles(rawArticles);

    return {
      raw: json,
      normalized,
    };
  }

  // ────────────────────────────────────────────────────────────────
  // 2) FALLBACK: no live seeds → synthetic topical generation
  // (keeps your system alive if feeds ever fail)
  // ────────────────────────────────────────────────────────────────
  console.warn(
    "[aiNewsGenerator] no live seeds available; falling back to synthetic generation."
  );

  const sysFallback = `
You are an experienced human news editor writing for the Indian digital publication "The Timely Voice".

Assume today's date on your desk is ${todayStr} (year ${currentYear}).

Your job:
- Draft realistic, wire-style news articles about plausible real-world events.
- Prioritise Indian audience needs: India, World, Business, Economy, and Tech that affect India.
- Maintain a neutral, factual tone. Avoid hype, opinion, or clickbait.
- You MUST return only strict JSON. Do not include commentary, markdown, or explanations outside the JSON structure.`;

  const userFallback = `
Generate ${requestedCount} different news articles as a single JSON object.

GENERAL REQUIREMENTS:
- Categories should be spread across: ${cats.join(", ")}. Variety is preferred.
- Aim for 600–900 words per article body, but DO NOT fail or stop if you produce fewer words. Shorter pieces are acceptable.
- Use clear, informative headlines (70–80 characters) that describe the main event.
- First paragraph should contain the key "who / what / where / when".
- Include relevant context in later paragraphs: why it matters, background, numbers or trends when you are reasonably confident.
- Audience: primarily Indian readers, but you may cover global stories that impact India or are major world developments.
- Tone mode: ${modePhrase}
- Trending bias: ${trendingPhrase}
- Topic diversity: ${diversityPhrase}

AVOID:
- Repeating the same subject again and again across articles.
- Fake highly-specific details (exact vote counts, very precise financial data, or fabricated quotes) when you are uncertain.
- Opinionated language ("disastrous", "amazing", etc.). Use neutral news language.

OUTPUT FORMAT (single JSON object, nothing else):

{
  "articles": [
    {
      "title": "Headline 70–80 characters",
      "slug": "kebab-case-url-slug",
      "summary": "60–80 word summary of the article.",
      "author": "Desk",
      "category": "World | India | Business | Tech | Sports | Politics | Economy | Science",
      "publishAt": "ISO 8601 datetime string (e.g. ${currentYear}-12-07T09:30:00+05:30)",
      "tags": ["short", "topic", "keywords"],
      "seo": {
        "imageAlt": "Accessible description of the main photo",
        "metaTitle": "<=80 character SEO title",
        "metaDescription": "<=200 character SEO description",
        "ogImageUrl": ""
      },
      "body": "Plain-text body with paragraph breaks. Aim for 600–900 words, but shorter is allowed."
    }
  ]
}`;

  const messagesFallback = [
    { role: "system", content: sysFallback },
    { role: "user", content: userFallback },
  ];

  const jsonFallback = await callOpenRouter({
    messages: messagesFallback,
    model: AUTOMATION_MODEL,
    apiKey:
      (process.env.OPENROUTER_API_KEY_AUTOMATION ||
        process.env.OPENROUTER_API_KEY ||
        "").trim(),
    max_tokens: requestedCount * 2200,
    temperature: 0.9, // more variety when not locked to seeds
  });

  let rawArticlesFallback = [];
  if (Array.isArray(jsonFallback?.articles)) {
    rawArticlesFallback = jsonFallback.articles;
  } else if (Array.isArray(jsonFallback)) {
    rawArticlesFallback = jsonFallback;
  } else if (
    jsonFallback &&
    typeof jsonFallback === "object" &&
    Array.isArray(jsonFallback.data)
  ) {
    rawArticlesFallback = jsonFallback.data;
  }

  const normalizedFallback = softFilterArticles(rawArticlesFallback);

  return {
    raw: jsonFallback,
    normalized: normalizedFallback,
  };
}

module.exports = {
  generateNewsBatch,
};
