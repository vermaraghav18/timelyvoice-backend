"use strict";

const { STOPWORDS } = require("./imagePickerRules");

// Your existing normalize style: remove hash/punct, keep a-z0-9_-
// We’ll keep it consistent so tag matching works reliably.
function normalizeToken(raw = "") {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  const noHash = s.replace(/^#+/g, "");
  const clean = noHash.replace(/[^a-z0-9_-]/g, "");
  return clean;
}

function splitWords(text = "") {
  return String(text || "")
    .toLowerCase()
    .replace(/[\u2019']/g, "") // remove apostrophes
    .replace(/[^a-z0-9\s-]/g, " ") // punctuation -> space
    .split(/\s+/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

// Build phrases like "raghavchadha", "righttorecall"
function makeBigrams(tokens = []) {
  const out = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (!a || !b) continue;
    out.push(`${a}${b}`);
    out.push(`${a}-${b}`);
  }
  return out;
}

/**
 * Extract keywords from title+summary:
 * - removes stopwords
 * - keeps tokens length >= 4 (reduces noise)
 * - includes bigrams to catch names/phrases
 */
function extractKeywords(title = "", summary = "", max = 40) {
  const text = `${title || ""} ${summary || ""}`.trim();
  const rawTokens = splitWords(text);

  const filtered = rawTokens
    .map(normalizeToken)
    .filter(Boolean)
    .filter((t) => t.length >= 4)
    .filter((t) => !STOPWORDS.has(t));

  const bigrams = makeBigrams(filtered).map(normalizeToken).filter(Boolean);

  // Keep unique, limit size
  const uniq = Array.from(new Set([...filtered, ...bigrams]));
  return uniq.slice(0, max);
}

module.exports = {
  normalizeToken,
  extractKeywords,
};
