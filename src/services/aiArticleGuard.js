// backend/src/services/aiArticleGuard.js
"use strict";

/**
 * AI Article Guard
 * -----------------
 * Centralised duplicate / topic protection for AI news generation.
 *
 * Layers:
 *  1) Hard dedupe by canonical source URL (sourceUrlCanonical).
 *  2) Jaccard title similarity vs recent articles (same category, last 24h).
 *  3) Topic fingerprints (RssTopicFingerprint) to limit 1 article per topic
 *     per time window (e.g. 24h) even if RSS keeps shouting about it.
 */

const Article = require("../models/Article");
const RssTopicFingerprint = require("../models/RssTopicFingerprint");

// --------------------------------------------------------------
// CONFIG
// --------------------------------------------------------------

// How far back to look when checking recent articles for similarity.
const RECENT_ARTICLE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// Jaccard similarity threshold (0–1) above which we treat as duplicate.
const TITLE_SIMILARITY_THRESHOLD = 0.8;

// Per-topic article limit and time window.
const TOPIC_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const TOPIC_MAX_ARTICLES_PER_WINDOW = 1;

// --------------------------------------------------------------
// URL NORMALIZATION
// --------------------------------------------------------------

function canonicalizeSourceUrl(raw = "") {
  if (!raw) return "";
  try {
    const u = new URL(String(raw).trim());

    // drop query + hash (tracking etc.)
    u.search = "";
    u.hash = "";

    // normalize host + path
    const host = u.hostname.toLowerCase();
    let pathname = u.pathname || "/";

    // strip trailing slashes
    if (pathname.length > 1) {
      pathname = pathname.replace(/\/+$/, "");
    }

    // special handling for sites that embed IDs in URL (TOI, etc.)
    // e.g. /articleshow/12345678.cms?from=mdr  →  /articleshow/12345678.cms
    pathname = pathname.replace(/(articleshow\/\d+)\.cms.*/i, "$1.cms");

    return `${host}${pathname}`; // host + path only
  } catch {
    // Fallback: very rough normalization
    return String(raw).trim().toLowerCase().replace(/[#?].*$/, "");
  }
}

// --------------------------------------------------------------
// TOKENIZATION / SIMILARITY
// --------------------------------------------------------------

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "for",
  "to",
  "on",
  "in",
  "by",
  "at",
  "as",
  "and",
  "or",
  "but",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "from",
  "with",
  "over",
  "under",
  "into",
  "out",
  "new",
  "latest",
  "today",
  "live",
  "update",
  "updates",
  "breaking",
  "report",
  "reports",
  "after",
  "before",
  "amid",
  "towards",
  "toward",
  "day",
  "week",
  "month",
  "year",
  "crore",
  "lakh",
  "vs",
  "v",
  "india",
  "indian",
  "world",
  "global",
]);

function tokenizeTitle(str = "") {
  return String(str)
    .toLowerCase()
    // remove brackets etc.
    .replace(/[\[\]\(\)\.\,\:\;\!\?\“\”\"\'\-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t && !STOPWORDS.has(t));
}

function uniqueTokens(tokens) {
  return Array.from(new Set(tokens));
}

function jaccardSimilarity(tokensA, tokensB) {
  const a = uniqueTokens(tokensA);
  const b = uniqueTokens(tokensB);
  if (!a.length || !b.length) return 0;

  const setA = new Set(a);
  const setB = new Set(b);

  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection += 1;
  }

  const union = setA.size + setB.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

// Build a combined title+summary token list for a seed
function tokensForSeed(seed = {}) {
  const base = `${seed.title || ""} ${seed.summary || ""}`;
  return tokenizeTitle(base);
}

// --------------------------------------------------------------
// TOPIC KEY
// --------------------------------------------------------------

function computeTopicKey(seed = {}) {
  // We build from title + summary.
  const tokens = tokensForSeed(seed);

  if (!tokens.length) return "";

  // Keep "strong" tokens first (longer words), then slice to fixed size.
  const sorted = uniqueTokens(tokens).sort((a, b) => b.length - a.length);

  // limit to top 6 tokens for stability
  const keyTokens = sorted.slice(0, 6).sort(); // sorted for deterministic key

  return keyTokens.join(" ");
}

// --------------------------------------------------------------
// DB HELPERS
// --------------------------------------------------------------

async function existsArticleWithCanonicalSource(seed = {}) {
  const link =
    seed.link || seed.url || seed.sourceUrl || seed.source_link || "";
  const canonical = canonicalizeSourceUrl(link);
  if (!canonical) return false;

  const existing = await Article.findOne({
    sourceUrlCanonical: canonical,
  }).select("_id");

  return !!existing;
}

async function isTooSimilarToRecentArticles(seed = {}) {
  const tokensSeed = tokensForSeed(seed);
  if (!tokensSeed.length) return false;

  const since = new Date(Date.now() - RECENT_ARTICLE_WINDOW_MS);

  const query = {
    createdAt: { $gte: since },
  };

  if (seed.category) {
    query.category = seed.category;
  }

  const recent = await Article.find(query)
    .select("title summary category createdAt")
    .lean();

  for (const art of recent) {
    const base = `${art.title || ""} ${art.summary || ""}`;
    const tokensArticle = tokenizeTitle(base);
    const sim = jaccardSimilarity(tokensSeed, tokensArticle);

    if (sim >= TITLE_SIMILARITY_THRESHOLD) {
      return true;
    }
  }

  return false;
}

async function wouldExceedTopicLimit(seed = {}) {
  const topicKey = computeTopicKey(seed);
  if (!topicKey) return false;

  const category = seed.category || null;

  const fp = await RssTopicFingerprint.findOne({
    key: topicKey,
    category,
  }).lean();

  if (!fp) return false;

  const now = Date.now();
  const lastSeen = fp.lastSeenAt ? new Date(fp.lastSeenAt).getTime() : 0;

  if (!lastSeen || now - lastSeen > TOPIC_WINDOW_MS) {
    // Window expired → allow again
    return false;
  }

  // Inside the active window – do we already have enough articles?
  return (fp.articleCount || 0) >= TOPIC_MAX_ARTICLES_PER_WINDOW;
}

// --------------------------------------------------------------
// PUBLIC API
// --------------------------------------------------------------

/**
 * Decide whether we should generate an AI article for this seed.
 *
 * Returns:
 *   { ok: true }
 * or { ok: false, reason: 'dupe_source' | 'dupe_similar' | 'dupe_topic' }
 */
async function shouldGenerateFromSeed(seed = {}) {
  // 1) Hard dedupe by canonical source URL (TOI link etc.)
  if (await existsArticleWithCanonicalSource(seed)) {
    return { ok: false, reason: "dupe_source" };
  }

  // 2) Fuzzy similarity vs recent articles (same category, last 24h)
  if (await isTooSimilarToRecentArticles(seed)) {
    return { ok: false, reason: "dupe_similar" };
  }

  // 3) Topic fingerprint window
  if (await wouldExceedTopicLimit(seed)) {
    return { ok: false, reason: "dupe_topic" };
  }

  return { ok: true };
}

/**
 * Mark that we actually generated & saved an article for this seed/topic.
 * Call this AFTER Article.create / save.
 */
async function markTopicUsed(seed = {}, articleId = null) {
  const topicKey = computeTopicKey(seed);
  if (!topicKey) return;

  const category = seed.category || null;
  const now = new Date();

  const update = {
    $setOnInsert: {
      firstSeenAt: now,
    },
    $set: {
      lastSeenAt: now,
    },
    $inc: {
      seedCount: 1,
      articleCount: 1,
    },
  };

  if (articleId) {
    update.$addToSet = { articleIds: articleId };
  }

  await RssTopicFingerprint.findOneAndUpdate(
    { key: topicKey, category },
    update,
    { upsert: true, new: true }
  );
}

/**
 * Optional helper: mark that we saw the topic in RSS but did NOT generate
 * an article (skipped due to guard). This keeps seedCount accurate.
 */
async function markSeedSeen(seed = {}) {
  const topicKey = computeTopicKey(seed);
  if (!topicKey) return;

  const category = seed.category || null;
  const now = new Date();

  await RssTopicFingerprint.findOneAndUpdate(
    { key: topicKey, category },
    {
      $setOnInsert: {
        firstSeenAt: now,
      },
      $set: {
        lastSeenAt: now,
      },
      $inc: {
        seedCount: 1,
      },
    },
    { upsert: true }
  );
}

module.exports = {
  shouldGenerateFromSeed,
  markTopicUsed,
  markSeedSeen,
  canonicalizeSourceUrl,
};
