// backend/src/services/aiArticleGuard.js
"use strict";

/**
 * AI Article Guard
 * ----------------
 * Phase 8: DB-level safety & de-duplication.
 *
 * Goal: prevent nearly identical AI headlines from being created
 * repeatedly within a recent time window.
 *
 * Strategy:
 * - Look back N hours (default: 72h) in Article collection
 * - Only consider AI-created articles (source === "ai-batch")
 * - Compare tokenized titles
 * - If token-overlap score >= threshold (default 0.75), treat as duplicate
 */

const Article = require("../models/Article");

// Configurable via .env if you ever want to tweak
const DEFAULT_DUP_WINDOW_HOURS = parseInt(
  process.env.AI_DUPLICATE_WINDOW_HOURS || "72",
  10
);

const DUP_OVERLAP_THRESHOLD = parseFloat(
  process.env.AI_DUPLICATE_TITLE_THRESHOLD || "0.75"
);

/**
 * Normalize a title into tokens:
 * - lowercase
 * - remove punctuation
 * - split on whitespace
 * - drop very short tokens (<= 2 chars)
 */
function tokenizeTitle(title = "") {
  const s = String(title || "")
    .toLowerCase()
    .replace(/["'’”“.,!?;:()[\]{}<>/\\|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!s) return [];

  const tokens = s
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length > 2);

  return Array.from(new Set(tokens)); // unique tokens
}

/**
 * Compute an overlap score between 0 and 1 based on token sets.
 * We use max( common/A , common/B ) so it’s robust if one title
 * is a slightly longer variant of the other.
 */
function computeTokenOverlapScore(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;

  const setB = new Set(tokensB);
  let common = 0;

  for (const t of tokensA) {
    if (setB.has(t)) common += 1;
  }

  const overlapA = common / tokensA.length;
  const overlapB = common / tokensB.length;

  return Math.max(overlapA, overlapB);
}

/**
 * Check if a candidate title is too similar to any recent AI-created article.
 *
 * Returns:
 *  {
 *    skip: boolean,
 *    reason?: "title_duplicate_recent",
 *    score?: number,
 *    matched?: { slug, title, createdAt }
 *  }
 */
async function shouldSkipAsDuplicate({ title, windowHours } = {}) {
  const cleanTitle = String(title || "").trim();
  if (!cleanTitle) {
    return { skip: false };
  }

  const tokensCandidate = tokenizeTitle(cleanTitle);
  if (!tokensCandidate.length) {
    return { skip: false };
  }

  const hours = Number.isFinite(windowHours)
    ? Math.max(1, windowHours)
    : DEFAULT_DUP_WINDOW_HOURS;

  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  // Only look at AI-created articles in recent window
  const recent = await Article.find(
    {
      source: "ai-batch",
      createdAt: { $gte: since },
    },
    { title: 1, slug: 1, createdAt: 1 }
  )
    .sort({ createdAt: -1 })
    .limit(500) // safety cap
    .lean();

  let bestScore = 0;
  let bestMatch = null;

  for (const doc of recent) {
    const docTitle = (doc.title || "").toString();
    const tokensExisting = tokenizeTitle(docTitle);
    if (!tokensExisting.length) continue;

    const score = computeTokenOverlapScore(tokensCandidate, tokensExisting);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = doc;
    }
  }

  if (bestMatch && bestScore >= DUP_OVERLAP_THRESHOLD) {
    console.log(
      "[aiArticleGuard] duplicate detected title=%s matchedSlug=%s score=%s",
      cleanTitle,
      bestMatch.slug,
      bestScore.toFixed(2)
    );

    return {
      skip: true,
      reason: "title_duplicate_recent",
      score: bestScore,
      matched: {
        slug: bestMatch.slug,
        title: bestMatch.title,
        createdAt: bestMatch.createdAt,
      },
    };
  }

  return { skip: false };
}

module.exports = {
  shouldSkipAsDuplicate,
};
