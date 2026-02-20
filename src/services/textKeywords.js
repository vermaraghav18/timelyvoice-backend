"use strict";

// Simple stopword list (keep it small and safe)
const STOP = new Set([
  "the","a","an","and","or","of","to","in","on","for","with","as","at","by","from",
  "is","are","was","were","be","been","being","it","this","that","these","those",
  "after","before","into","over","under","against","between","during","about",
  "today","latest","news","report","reports","says","say"
]);

// ------------------------------
// ✅ Canonical tag variants
// Goal: AI should not output both "politics" and "political" etc.
// We standardize to ONE preferred tag.
// Keep this list small and extend only when needed.
// ------------------------------
const CANONICAL_TAG_MAP = new Map([
  // politics
  ["political", "politics"],
  ["politician", "politics"],
  ["politicians", "politics"],

  // economy/finance
  ["economic", "economy"],
  ["economical", "economy"],

  // law/legal
  ["laws", "law"],
  ["legal", "law"],
  ["legally", "law"],

  // parliament/legislation
  ["legislative", "parliament"],
  ["legislation", "parliament"],
  ["legislature", "parliament"],

  // security/defence spelling variants (optional)
  ["defense", "defence"],
]);

function canonicalizeTag(t) {
  const x = String(t || "").trim().toLowerCase();
  if (!x) return "";
  return CANONICAL_TAG_MAP.get(x) || x;
}

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
// NOTE: This intentionally removes spaces & symbols to match ImageLibrary tag style.
function normTag(s) {
  // turn "Sri Lanka" -> "srilanka", "#T20 World Cup" -> "t20worldcup"
  const raw = String(s || "").replace(/[^a-z0-9]+/gi, "");
  const norm = normalizeToken(raw);
  if (!norm) return "";

  // ✅ Apply canonicalization AFTER normalization
  // Example: "political" -> "politics"
  return canonicalizeTag(norm);
}

/**
 * ✅ NEW: Expand multi-word entities into robust variants:
 * "Donald Trump" -> ["donald", "trump", "donaldtrump"]
 * "New York" -> ["new", "york", "newyork"]
 *
 * We return normalized tags (ImageLibrary style).
 */
function expandPhraseToTags(phrase) {
  const p = String(phrase || "").trim();
  if (!p) return [];

  const words = p
    .split(/\s+/g)
    .map((w) => String(w || "").trim())
    .filter(Boolean);

  if (words.length === 0) return [];

  const out = [];
  if (words.length === 1) {
    const t = normTag(words[0]);
    if (t) out.push(t);
    return out;
  }

  // each word
  for (const w of words) {
    const t = normTag(w);
    if (t) out.push(t);
  }

  // joined: donaldtrump
  const joined = normTag(words.join(""));
  if (joined) out.push(joined);

  return Array.from(new Set(out));
}

/**
 * ✅ NEW: Detect Proper Name phrases from original (non-lowercased) text.
 * We extract sequences like:
 * - "Donald Trump"
 * - "Marco Rubio"
 * - "United Nations"
 * - "Bharatiya Janata Party"
 *
 * Then we expand them into tags: first/last/joined.
 */
function extractNamePhrases(text, { maxPhrases = 6 } = {}) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return [];

  // Conservative regex:
  // - 2 to 4 words
  // - Each word starts with capital letter, allows internal letters/dots/apostrophes/hyphens
  // Examples: "U.S." won't match perfectly; that's ok (countries handled elsewhere).
  const re = /\b([A-Z][a-zA-Z.'-]{1,})(\s+[A-Z][a-zA-Z.'-]{1,}){1,3}\b/g;

  const phrases = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const phrase = String(m[0] || "").trim();

    // small safety filters
    const low = phrase.toLowerCase();
    if (STOP.has(low)) continue;

    // avoid "Latest News" type phrases
    if (/^(Latest|Breaking|Top|Live)\b/.test(phrase)) continue;

    phrases.push(phrase);
    if (phrases.length >= maxPhrases) break;
  }

  return phrases;
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

  const allTextLower = `${title || ""} ${summary || ""} ${seedTitle || ""} ${body || ""}`.toLowerCase();
  const allTextOriginal = `${title || ""} ${summary || ""} ${seedTitle || ""} ${body || ""}`.trim();

  // ✅ 1.5) NEW: Proper name phrases -> add split + joined
  // Example: "Donald Trump" -> donald, trump, donaldtrump
  const phrases = extractNamePhrases(allTextOriginal, { maxPhrases: 6 });
  for (const p of phrases) {
    for (const t of expandPhraseToTags(p)) out.push(t);
  }

  // 2) add sports + cup tokens
  for (const t of detectSportsTokens(allTextLower)) {
    const nt = normTag(t);
    if (nt) out.push(nt);
  }

  // 3) add countries
  for (const t of detectCountries(allTextLower)) {
    const nt = normTag(t);
    if (nt) out.push(nt);
  }

  // 4) keyword fallback
  const kw = extractKeywords(title || "", summary || "", 20);
  for (const k of kw) {
    const nt = normTag(k);
    if (nt) out.push(nt);
  }

  // de-dupe (AFTER canonicalization)
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
