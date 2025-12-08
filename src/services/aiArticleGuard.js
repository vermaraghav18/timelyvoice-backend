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

const Article = require("../../src/models/Article");

// How far back in time (in hours) to look for duplicates
const LOOKBACK_HOURS =
  parseInt(process.env.AI_DUP_LOOKBACK_HOURS || "72", 10) || 72;

// Minimum token overlap score to treat as duplicate
const DUP_THRESHOLD =
  Number(process.env.AI_DUP_THRESHOLD || "0.75") || 0.75;

// Minimum title length (in characters) to even bother comparing
const MIN_TITLE_LENGTH = 32;

// Simple tokenizer: lowercase, remove punctuation, split on whitespace
function tokenizeTitle(title = "") {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Compute a simple Jaccard-like overlap score between token sets
function tokenOverlapScore(aTokens = [], bTokens = []) {
  if (!aTokens.length || !bTokens.length) return 0;

  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);

  let intersection = 0;
  for (const t of aSet) {
    if (bSet.has(t)) intersection += 1;
  }

  const union = aSet.size + bSet.size - intersection;
  if (!union) return 0;
  return intersection / union;
}

/**
 * shouldSkipAsDuplicate({ title })
 *
 * Returns:
 *   { skip: boolean, matched?: { slug, title, createdAt } }
 */
async function shouldSkipAsDuplicate({ title }) {
  const cleanTitle = String(title || "").trim();

  // If title too short, don't treat as duplicate
  if (!cleanTitle || cleanTitle.length < MIN_TITLE_LENGTH) {
    return { skip: false };
  }

  // Compute time window
  const now = new Date();
  const since = new Date(now.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000);

  // Fetch recent AI-batch articles
  const recent = await Article.find({
    source: "ai-batch",
    createdAt: { $gte: since },
  })
    .select("slug title createdAt")
    .sort({ createdAt: -1 })
    .lean();

  if (!recent || !recent.length) {
    return { skip: false };
  }

  const newTokens = tokenizeTitle(cleanTitle);
  if (!newTokens.length) {
    return { skip: false };
  }

  let bestScore = 0;
  let bestMatch = null;

  for (const doc of recent) {
    const oldTitle = String(doc.title || "").trim();
    if (!oldTitle || oldTitle.length < MIN_TITLE_LENGTH) continue;

    const oldTokens = tokenizeTitle(oldTitle);
    if (!oldTokens.length) continue;

    const score = tokenOverlapScore(newTokens, oldTokens);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = doc;
    }
  }

  if (bestMatch && bestScore >= DUP_THRESHOLD) {
    return {
      skip: true,
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
