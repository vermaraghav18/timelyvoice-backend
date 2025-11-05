"use strict";

/**
 * OpenRouter service (Node 18+)
 * - Keeps your existing official-sources generator (generateJSONDraft)
 * - Adds a dedicated RSS automation generator (generateAutomationArticleDraft)
 * - Supports a separate model/key for automation so it doesn't touch your other models
 */

// Polyfill fetch for Node < 18 (Node 18+ already has global fetch)
const fetch = global.fetch || require("node-fetch");

// -------------------------------
// Config
// -------------------------------
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

// Your existing "default" model used elsewhere in the site
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";

// Dedicated model just for the RSS -> Article automation
const AUTOMATION_MODEL =
  process.env.OPENROUTER_MODEL_AUTOMATION ||
  process.env.OPENROUTER_MODEL ||
  DEFAULT_MODEL;

// Knobs for X-generation (long-form)
const XGEN_TARGET_WORDS =
  parseInt(process.env.XGEN_TARGET_WORDS || process.env.ARTICLE_MIN_BODY || "600", 10);
const XGEN_MAX_TOKENS = parseInt(process.env.XGEN_MAX_TOKENS || "1600", 10);

// Friendly boot logs (do not print secrets)
console.log("[OpenRouter] global model =", process.env.OPENROUTER_MODEL);
console.log("[OpenRouter] xgen model   =", process.env.OPENROUTER_MODEL_XGEN);
console.log(
  "[OpenRouter] automation   =",
  process.env.OPENROUTER_MODEL_AUTOMATION || "(fallback to global)"
);
console.log("[OpenRouter] xgen targetWords =", XGEN_TARGET_WORDS);
console.log("[OpenRouter] xgen max_tokens  =", XGEN_MAX_TOKENS);

// -------------------------------
// Helpers
// -------------------------------
function getHeaderMeta() {
  return {
    referer: process.env.SITE_URL || "http://localhost",
    title: process.env.PUBLICATION_NAME || "News Admin",
  };
}

/** Extract the last {...} JSON object from a string (in case model adds fluff) */
function extractLastJSONObject(str) {
  if (typeof str !== "string") return null;
  const m = str.match(/\{[\s\S]*\}$/);
  return m ? m[0] : null;
}

function safeParseJSON(raw) {
  // try direct parse first
  try {
    if (typeof raw === "string") return JSON.parse(raw);
    if (raw && typeof raw === "object") return raw;
  } catch (_) { /* ignore */ }
  // fallback: try extracting last {...}
  const last = extractLastJSONObject(String(raw || ""));
  if (!last) throw new Error("No JSON object found in model output");
  return JSON.parse(last);
}

/** Low-level OpenRouter caller that allows model/key overrides */
async function callOpenRouter({
  messages,
  model,
  apiKey,
  temperature = 0.3,
  max_tokens, // NEW: allow caller to set token budget
}) {
  const key =
    (apiKey ||
      process.env.OPENROUTER_API_KEY ||
      "").trim();

  if (!key) {
    throw new Error("Missing OpenRouter key (OPENROUTER_API_KEY or provided apiKey).");
  }

  const modelToUse = model || DEFAULT_MODEL;
  const meta = getHeaderMeta();

  const body = {
    model: modelToUse,
    temperature,
    response_format: { type: "json_object" }, // ask for JSON
    messages,
  };
  if (Number.isFinite(max_tokens)) body.max_tokens = max_tokens;

  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": meta.referer,
      "X-Title": meta.title,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error("OpenRouter returned empty content");
  return safeParseJSON(content);
}

// -------------------------------
// 1) EXISTING FUNCTION — now supports long-form bodies (targetWords)
// -------------------------------
async function generateJSONDraft({
  tweetText,
  extractText,
  defaults,
  sources,
  model,
  targetWords,   // NEW: optional override; falls back to env
  maxTokens,     // NEW: optional override; falls back to env
}) {
  // Model resolution: prefer explicit override, then xgen env, then default
  const useModel = model || process.env.OPENROUTER_MODEL_XGEN || DEFAULT_MODEL;

  const words = parseInt(String(targetWords || XGEN_TARGET_WORDS), 10);
  const maxTok = Number.isFinite(maxTokens) ? maxTokens : XGEN_MAX_TOKENS;

  const sys = `You write news article drafts from OFFICIAL Indian government sources only.
Return STRICTLY a JSON object with these fields:
{
  "title": "<70–80 chars>",
  "slug": "kebab-case-url-slug",
  "summary": "60–80 words.",
  "author": "Desk",
  "category": "Politics",
  "status": "Draft",
  "publishAt": "YYYY-MM-DDTHH:mm:ss+05:30",
  "imageUrl": "",
  "imagePublicId": "",
  "seo": {
    "imageAlt": "",
    "metaTitle": "<=80 chars>",
    "metaDescription": "<=200 chars>",
    "ogImageUrl": ""
  },
  "geo": { "mode": "Global", "areas": [] },
  "sourceUrl": "",
  "body": "<plain text body>"
}
Rules:
- Use ONLY the provided official sources (domains: *.gov.in or *.nic.in). Ignore everything else.
- Leave image fields blank.
- Keep neutral, factual tone.
- Slug must be kebab-case; append 6 random digits if needed to ensure uniqueness.
- BODY LENGTH: write a cohesive, paragraph-based body of approximately ${words}–${words + 200} words (no bullet lists). Ensure clarity, chronology, and attribution to the provided official sources only.`;

  const user = `
TWEET:
${tweetText || "(none)"}

VERIFIED SOURCES:
${(sources || []).map((s) => `- ${s.url}`).join("\n") || "(none)"}

EXTRACTED TEXT (from official pages):
${extractText || "(none)"}

DEFAULTS:
author=${defaults?.author}
category=${defaults?.category}
publishAt=${defaults?.publishAt}
geo.mode=${defaults?.geo?.mode}
`.trim();

  return callOpenRouter({
    model: useModel,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    temperature: 0.2,
    max_tokens: maxTok,
  });
}

// -------------------------------
// 2) NEW FUNCTION — dedicated to RSS automation pipeline
// -------------------------------
async function generateAutomationArticleDraft({
  extractedText,   // cleaned text from parsed article page(s)
  rssLink,         // original source URL (for reference only, do not quote)
  defaults = {},   // { author, category, publishAt, geo: { mode }, tagsHint? }
  model,           // optional override
}) {
  // Use dedicated automation envs, falling back to global where needed
  const apiKey =
    (process.env.OPENROUTER_API_KEY_AUTOMATION ||
      process.env.OPENROUTER_API_KEY ||
      "").trim();
  if (!apiKey) throw new Error("Missing OpenRouter key for automation (OPENROUTER_API_KEY[_AUTOMATION]).");

  const useModel = model || AUTOMATION_MODEL;

  const sys = `You are a newsroom writer and SEO editor. Create a SHORT, FULLY ORIGINAL article from source context.
STRICTLY return a JSON object with exactly these fields and nothing else:
{
  "title": "<70–80 char headline>",
  "slug": "kebab-case-url-slug",
  "summary": "60–80 words.",
  "author": "Desk",
  "category": "Sports",
  "status": "Published",
  "publishAt": "YYYY-MM-DDTHH:mm:ss+05:30",
  "imageUrl": "",
  "imagePublicId": "",
  "seo": {
    "imageAlt": "Accessible description",
    "metaTitle": "<=80 chars>",
    "metaDescription": "<=200 chars>",
    "ogImageUrl": ""
  },
  "geo": {
    "mode": "Global",
    "areas": ["country:IN"]
  },
  "tags": ["tag1","tag2","tag3"],
  "body": "600-word article body in plain text, divided into 4–6 short paragraphs."

}
HARD RULES (very important):
- DO NOT copy or quote sentences from the source; write *original* language. Avoid near-paraphrasing of unique phrases.
- Keep neutral, factual tone; verify claims within the provided context only.
- Title 70–80 chars; Summary 60–80 words; Body around 600 words (roughly 4–6 paragraphs), plain text with paragraph breaks.

- Category: use the provided default if given, else choose best from: Sports, Politics, Tech, Business, Entertainment, World, Science, Health.
- Tags: 3–6 short topical keywords (no hashtags).
- Slug: kebab-case; ensure uniqueness by appending 6 random digits if needed.
- publishAt: use the provided default if present; format with +05:30 offset.
- Leave imageUrl, imagePublicId, seo.ogImageUrl as empty strings (images will be added later).
- seo.imageAlt must be a descriptive sentence for accessibility.
- Output ONLY the JSON object (no Markdown, no commentary).`;

  const user = `
ORIGINAL RSS LINK (do not quote it): ${rssLink || "(unknown)"}

EXTRACTED CONTEXT (for verification only):
${extractedText || "(none)"}

DEFAULTS:
author=${defaults.author || "Desk"}
category=${defaults.category || "(auto)"}
publishAt=${defaults.publishAt || "(auto now +05:30)"}
geo.mode=${defaults?.geo?.mode || "Global"}
tagsHint=${Array.isArray(defaults.tagsHint) ? defaults.tagsHint.join(", ") : "(none)"}
`.trim();

  const meta = getHeaderMeta();

  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": meta.referer,
      "X-Title": "TimelyVoice Automation",
    },
   body: JSON.stringify({
    model: useModel,
    temperature: 0.3,
    response_format: { type: "json_object" },
    max_tokens: XGEN_MAX_TOKENS, // ensure enough room for ~600 words
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
  }),

  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  const obj = safeParseJSON(content);

  // Minimal schema guards
  const required = [
    "title","slug","summary","author","category","status",
    "publishAt","imageUrl","imagePublicId","seo","geo","tags","body"
  ];
  for (const k of required) {
    if (!(k in obj)) throw new Error(`LLM output missing field: ${k}`);
  }
  if (!Array.isArray(obj.tags)) throw new Error("LLM output 'tags' must be an array");
  if (!obj.seo || typeof obj.seo !== "object") throw new Error("LLM output 'seo' must be an object");
  if (!obj.geo || typeof obj.geo !== "object") throw new Error("LLM output 'geo' must be an object");

  return obj;
}

// -------------------------------
// Exports
// -------------------------------
module.exports = {
  // Generic low-level caller (your other features can keep using it)
  callOpenRouter,

  // Existing flow (official sources) — now length-configurable
  generateJSONDraft,

  // New dedicated automation flow (Claude 3 Haiku)
  generateAutomationArticleDraft,
};
