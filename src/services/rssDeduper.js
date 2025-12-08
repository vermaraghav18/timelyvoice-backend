// backend/src/services/rssDeduper.js
// Simple topic-key generator to avoid duplicate AI articles

const crypto = require("crypto");

/**
 * Normalize text: lowercase, remove extra symbols, collapse spaces.
 */
function normalizeText(s = "") {
  return String(s || "")
    .toLowerCase()
    .replace(/https?:\/\/(www\.)?/g, "") // strip protocol & www
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * computeTopicKey(title, link)
 * - Creates a short hash for "this topic" so we can detect duplicates.
 */
function computeTopicKey(title, link = "") {
  const t = normalizeText(title);
  const l = normalizeText(link);

  if (!t && !l) return null;

  const combined = `${t}|${l}`;
  const hash = crypto
    .createHash("sha256")
    .update(combined)
    .digest("hex")
    .slice(0, 24); // short but unique enough

  return hash;
}

module.exports = { computeTopicKey };
