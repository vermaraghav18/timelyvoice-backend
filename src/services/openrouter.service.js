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

// Friendly boot logs (do not print secrets)
console.log("[OpenRouter] global model =", process.env.OPENROUTER_MODEL);
console.log("[OpenRouter] xgen model   =", process.env.OPENROUTER_MODEL_XGEN);
console.log(
  "[OpenRouter] automation   =",
  process.env.OPENROUTER_MODEL_AUTOMATION || "(fallback to global)"
);

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
async function callOpenRouter({ messages, model, apiKey, temperature = 0.3 }) {
  const key =
    (apiKey ||
      process.env.OPENROUTER_API_KEY ||
      "").trim();

  if (!key) {
    throw new Error("Missing OpenRouter key (OPENROUTER_API_KEY or provided apiKey).");
  }

  const modelToUse = model || DEFAULT_MODEL;
  const meta = getHeaderMeta();

  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": meta.referer,
      "X-Title": meta.title,
    },
    body: JSON.stringify({
      model: modelToUse,
      temperature,
      response_format: { type: "json_object" }, // ask for JSON
      messages,
    }),
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
// 1) EXISTING FUNCTION — keep behavior for official sources
// -------------------------------
async function generateJSONDraft({ tweetText, extractText, defaults, sources, model }) {
  // Uses your app's DEFAULT model & key (backwards compatible)
  const useModel = model || DEFAULT_MODEL;

  const sys = `You write concise news article drafts from OFFICIAL Indian government sources only.
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
- Use ONLY the provided official sources (gov.in / nic.in). Ignore everything else.
- Leave image fields blank.
- Keep neutral, factual tone.
- slug must be kebab-case; append 6 random digits if needed to ensure uniqueness.`;

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
    // keep it a bit conservative for this flow
    temperature: 0.2,
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
  "body": "200-word article body in plain text, with paragraph breaks."
}
HARD RULES (very important):
- DO NOT copy or quote sentences from the source; write *original* language. Avoid near-paraphrasing of unique phrases.
- Keep neutral, factual tone; verify claims within the provided context only.
- Title 70–80 chars; Summary 60–80 words; Body ~200 words (2–3 paragraphs), plain text.
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

  // Existing flow (official sources)
  generateJSONDraft,

  // New dedicated automation flow (Claude 3 Haiku)
  generateAutomationArticleDraft,
};
