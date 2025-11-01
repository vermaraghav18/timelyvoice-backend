// backend/src/services/textFeatures.js
// Minimal keyword extractor (Unicode-safe). Swap for NLP later if needed.

const STOP = new Set([
  "the","a","an","and","or","but","if","on","in","to","of","for","with","by","as","at","from",
  "that","this","is","are","was","were","be","been","it","its","into","over","under","than",
  "new","latest","says","said","report","via"
]);

function extractTags({ title = "", summary = "", body = "" }, max = 8) {
  const text = (String(title) + " " + String(summary) + " " + String(body))
    .toLowerCase()
    // Unicode letters/numbers + spaces; strip punctuation
    .replace(/[^\p{L}\p{N}\s]/gu, " ");

  const counts = new Map();
  for (const raw of text.split(/\s+/g)) {
    const w = raw.trim();
    if (!w || STOP.has(w) || w.length < 3) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a,b) => b[1] - a[1])
    .slice(0, max)
    .map(([w]) => w);
}

module.exports = { extractTags };
