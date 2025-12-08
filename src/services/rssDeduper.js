// backend/src/services/rssDeduper.js
const crypto = require("crypto");
const RssTopicFingerprint = require("../models/RssTopicFingerprint");

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "in",
  "on",
  "for",
  "at",
  "to",
  "from",
  "and",
  "or",
  "with",
  "by",
  "as",
  "over",
  "about",
  "after",
  "before",
  "this",
  "that",
  "these",
  "those",
  "today",
  "update",
  "latest",
  "breaking",
  "live",
]);

function normalizeTitle(raw = "") {
  return raw
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, " ") // remove [LIVE], [UPDATE]
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function computeTopicKey(title, link = "") {
  const norm = normalizeTitle(title);
  const tokens = norm.split(" ").filter((w) => w && !STOPWORDS.has(w));
  const reduced = [...new Set(tokens)].slice(0, 16).sort().join(" ");

  // Combine reduced title tokens + domain path
  const linkPart = link.replace(/^https?:\/\//i, "").split(/[?#]/)[0];
  const seed = `${reduced || norm}|${linkPart}`;

  return crypto.createHash("sha1").update(seed).digest("hex");
}

// Deduplicate inside one batch by link
function dedupeByLink(rawItems) {
  const seen = new Set();
  const out = [];

  for (const item of rawItems) {
    const link = (item.link || item.url || "").trim();
    if (!link) {
      out.push(item);
      continue;
    }
    const key = link.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

/**
 * Filter RSS items so AI only sees "fresh topics".
 * @param {Array} rawItems - [{ title, link, summary, sourceId, ... }]
 * @returns {Promise<Array>} - only new items
 */
async function filterNewRssItems(rawItems) {
  const uniqueItems = dedupeByLink(rawItems);

  const result = [];

  for (const item of uniqueItems) {
    const title = item.title || "";
    const link = item.link || item.url || "";
    if (!title) continue;

    const topicKey = computeTopicKey(title, link);
    const sourceId = item.sourceId || item.feedName || "unknown";

    // Atomic upsert:
    // - if topicKey exists -> existing doc is returned, we SKIP
    // - if not -> new doc inserted, we KEEP this item
    const existing = await RssTopicFingerprint.findOneAndUpdate(
      { topicKey },
      {
        $setOnInsert: {
          topicKey,
          firstSeenAt: new Date(),
        },
        $set: {
          latestTitle: title,
          latestLink: link,
          lastSeenAt: new Date(),
        },
        $addToSet: { sourceIds: sourceId },
      },
      { new: false, upsert: true }
    ).lean();

    if (existing) {
      // already seen this topic in the last 48h → skip
      continue;
    }

    result.push({ ...item, topicKey });
  }

  return result;
}

module.exports = {
  filterNewRssItems,
  normalizeTitle,
  computeTopicKey,
};
