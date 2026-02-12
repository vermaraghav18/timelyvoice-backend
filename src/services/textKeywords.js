"use strict";

// Simple stopword list (keep it small and safe)
const STOP = new Set([
  "the","a","an","and","or","of","to","in","on","for","with","as","at","by","from",
  "is","are","was","were","be","been","being","it","this","that","these","those",
  "after","before","into","over","under","against","between","during","about",
  "today","latest","news","report","reports","says","say"
]);

// Normalize tokens/tags into your ImageLibrary style (no spaces, lowercase, alnum/_/-)
function normalizeToken(s) {
  const t = String(s || "").trim().toLowerCase();
  if (!t) return "";
  return t
    .replace(/^#+/g, "")
    .replace(/[^a-z0-9_-]+/g, "")
    .trim();
}

// Backward compatible alias (your older code used normTag)
function normTag(s) {
  // turn "Sri Lanka" -> "srilanka", "#T20 World Cup" -> "t20worldcup"
  return normalizeToken(String(s || "").replace(/[^a-z0-9]+/gi, ""));
}

// Detect some sports + formats
function detectSportsTokens(text) {
  const s = String(text || "").toLowerCase();
  const out = new Set();

  if (/\bcricket\b/.test(s)) out.add("cricket");
  if (/\bt20\b/.test(s) || /\bt20i\b/.test(s)) out.add("t20");
  if (/\bodi\b/.test(s)) out.add("odi");
  if (/\btest\b/.test(s) || /\btestmatch\b/.test(s)) out.add("test");

  if (/\bworld\s*cup\b/.test(s)) out.add("worldcup");
  if (/\bt20\s*world\s*cup\b/.test(s)) out.add("t20worldcup");

  return Array.from(out);
}

// Country quick-map (add more anytime)
const COUNTRY_ALIASES = [
  ["sri lanka","srilanka"],
  ["south africa","southafrica"],
  ["new zealand","newzealand"],
  ["united states","usa"],
  ["united kingdom","uk"],
  ["uae","uae"],
];

function detectCountries(text) {
  const s = String(text || "").toLowerCase();
  const out = new Set();

  for (const [needle, tag] of COUNTRY_ALIASES) {
    if (s.includes(needle)) out.add(tag);
  }

  // single-word countries (simple)
  const singles = [
    "india","oman","australia","ireland","pakistan","iran","afghanistan",
    "england","bangladesh","nepal","china","russia","ukraine","israel","gaza"
  ];
  for (const c of singles) {
    if (new RegExp(`\\b${c}\\b`, "i").test(s)) out.add(c);
  }

  return Array.from(out);
}

// Internal helper: extract keywords from one string
function extractKeywordsFromText(text, limit = 12) {
  const s = String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!s) return [];

  const words = s.split(" ").filter(Boolean);
  const freq = new Map();

  for (const w of words) {
    if (w.length < 3) continue;
    if (STOP.has(w)) continue;
    if (/^\d+$/.test(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }

  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .map((x) => x[0])
    .slice(0, limit);
}

/**
 * ✅ IMPORTANT: imageStrategy.js calls:
 *   extractKeywords(title, summary, max)
 * So we provide this exact signature.
 */
function extractKeywords(title = "", summary = "", max = 12) {
  const text = `${title || ""} ${summary || ""}`.trim();
  return extractKeywordsFromText(text, max);
}

// MAIN: build final tag list (min 6, max 8)
function buildArticleTags({ rawTags, title, summary, body, seedTitle, min = 6, max = 8 }) {
  const out = [];

  // 1) model tags (if any)
  if (Array.isArray(rawTags)) {
    for (const t of rawTags) {
      const nt = normTag(t);
      if (nt) out.push(nt);
    }
  }

  const allText = `${title || ""} ${summary || ""} ${seedTitle || ""} ${body || ""}`;

  // 2) add sports + cup tokens
  for (const t of detectSportsTokens(allText)) out.push(normTag(t));

  // 3) add countries
  for (const t of detectCountries(allText)) out.push(normTag(t));

  // 4) keyword fallback
  const kw = extractKeywords(title || "", summary || "", 20);
  for (const k of kw) out.push(normTag(k));

  // de-dupe
  const uniq = Array.from(new Set(out)).filter(Boolean);

  // remove ultra-generic junk if it’s crowding
  const filtered = uniq.filter((t) => !["general","world","breaking"].includes(t));

  // enforce min/max
  const final = filtered.slice(0, max);

  // absolute fallback if still too short
  if (final.length < min) {
    // add a safe filler that won't harm matching too much
    if (!final.includes("news")) final.push("news");
  }

  return final.slice(0, max);
}

module.exports = {
  // used by aiNewsGenerator
  buildArticleTags,

  // used by imageStrategy
  extractKeywords,
  normalizeToken,
};
