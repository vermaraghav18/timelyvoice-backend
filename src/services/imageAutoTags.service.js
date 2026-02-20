// backend/src/services/imageAutoTags.service.js
"use strict";

// Lazy fetch polyfill
const fetch =
  typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const OPENROUTER_BASE = process.env.OPENROUTER_BASE || "https://openrouter.ai/api/v1";
const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY || "").trim();

// Pass 1 (cheap) model
const IMAGE_TAG_MODEL =
  process.env.OPENROUTER_MODEL_IMAGETAGS ||
  process.env.OPENROUTER_MODEL ||
  "openai/gpt-4o-mini";

// Pass 2 (strong) model - only used when person name is missing
const IMAGE_TAG_MODEL_STRONG =
  process.env.OPENROUTER_MODEL_IMAGETAGS_STRONG ||
  "openai/gpt-4o";

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Heuristic: detect if tags already contain a person name.
 * We want to trigger a stronger second pass ONLY when needed.
 *
 * Examples that count as "has name":
 * - donaldtrump, narendramodi, chandrababunaidu
 * - donald + trump (separate tokens)
 */
function hasPersonNameTag(tags = []) {
  const arr = Array.isArray(tags) ? tags : [];
  if (arr.length === 0) return false;

  const lower = arr.map((t) => String(t || "").trim().toLowerCase()).filter(Boolean);
  if (lower.length === 0) return false;

  // If we see 2+ "name-like" tokens, assume person present
  const nameLikeWords = lower.filter((t) => /^[a-z]{4,}$/.test(t));
  if (nameLikeWords.length >= 2) return true;

  // If we see a joined long alpha token, often a full name
  const joined = lower.some((t) => /^[a-z]{10,}$/.test(t));
  if (joined) return true;

  return false;
}

/**
 * Heuristic: detect "this is a person/politician image" but no name returned.
 * That’s exactly your Chandrababu Naidu case.
 */
function looksLikePersonButNoName(tags = []) {
  const s = (Array.isArray(tags) ? tags : [])
    .map((t) => String(t || "").toLowerCase())
    .join(" ");

  // person/politics signals
  const personSignals = [
    "politician",
    "politics",
    "government",
    "president",
    "primeminister",
    "minister",
    "press",
    "pressconference",
    "speech",
    "podium",
    "rally",
    "parliament",
    "chiefminister",
    "cm",
  ];

  const hasSignal = personSignals.some((x) => s.includes(x));
  if (!hasSignal) return false;

  // if no name tag, then fallback should run
  return !hasPersonNameTag(tags);
}

async function callVisionModel({ imageUrl, model, max = 10, mode = "general" }) {
  const promptGeneral = `
You are tagging an image for a news Image Library.

Return ONLY JSON in this exact shape:
{ "tags": ["..."], "notes": "..." }

Rules:
- tags must be short, specific, lowercase.
- use 6 to ${max} tags.
- include: people names (if clear), country/state/city, organization/party, topic (politics/war/finance/sports/health).
- no hashtags, no emojis.
- If the image is a person, include BOTH full name and last name (e.g. "donald trump", "trump").
`.trim();

  const promptIdentifyPerson = `
You are tagging a NEWS image.

If the image contains a public figure and you can identify them confidently,
include their FULL NAME. If you are not confident, set person="unknown" and DO NOT guess.

Return ONLY JSON in this exact shape:
{ "tags": ["..."], "person": "<full name or unknown>", "confidence": 0-1, "notes": "..." }

Rules:
- tags must be short, specific, lowercase.
- use 6 to ${max} tags.
- If person is known, tags MUST include BOTH:
  - full name (e.g. "n. chandrababu naidu" / "chandrababu naidu")
  - last name (e.g. "naidu")
- include location/state if inferable from context (e.g. "andhra pradesh") and role tags (e.g. "chief minister") when appropriate.
- no hashtags, no emojis.
`.trim();

  const prompt = mode === "identify_person" ? promptIdentifyPerson : promptGeneral;

  const body = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: 350,
  };

  const resp = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://timelyvoice.com",
      "X-Title": "The Timely Voice - Image Auto Tags",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    return {
      ok: false,
      tags: [],
      raw: {
        ok: false,
        status: resp.status,
        statusText: resp.statusText,
        error: errText,
      },
    };
  }

  const data = await resp.json();
  const text =
    data?.choices?.[0]?.message?.content &&
    typeof data.choices[0].message.content === "string"
      ? data.choices[0].message.content
      : "";

  const json = safeJsonParse(String(text).trim());
  const tags = Array.isArray(json?.tags) ? json.tags : [];

  return { ok: true, tags, raw: json || { rawText: text } };
}

/**
 * Ask a vision model to produce ImageLibrary-ready tags.
 * ✅ NEW: 2-pass strategy
 * - Pass 1: cheap model (4o-mini)
 * - Pass 2: stronger model (4o) ONLY when person-like image has no name tags
 *
 * Returns: { tags: string[], raw?: any }
 */
async function generateImageTagsFromUrl(imageUrl, { max = 10 } = {}) {
  const url = String(imageUrl || "").trim();
  if (!url) throw new Error("imageUrl is required");

  if (!OPENROUTER_API_KEY) {
    // No key => do not block uploads; return empty.
    return { tags: [], raw: { skipped: true, reason: "OPENROUTER_API_KEY_missing" } };
  }

  // Pass 1 (cheap)
  const r1 = await callVisionModel({
    imageUrl: url,
    model: IMAGE_TAG_MODEL,
    max,
    mode: "general",
  });

  const tags1 = Array.isArray(r1?.tags) ? r1.tags : [];

  // If we got good tags and likely a person name, stop here.
  // Otherwise run pass 2 only when it looks like a person/politician but name missing.
  const needPass2 = looksLikePersonButNoName(tags1);

  if (!needPass2) {
    return { tags: tags1, raw: { pass: 1, pass1: r1.raw } };
  }

  // Pass 2 (strong)
  const r2 = await callVisionModel({
    imageUrl: url,
    model: IMAGE_TAG_MODEL_STRONG,
    max,
    mode: "identify_person",
  });

  const tags2 = Array.isArray(r2?.tags) ? r2.tags : [];

  // Merge unique
  const merged = Array.from(
    new Set([...(tags1 || []), ...(tags2 || [])].map((x) => String(x || "").trim()).filter(Boolean))
  );

  return { tags: merged, raw: { pass: 2, pass1: r1.raw, pass2: r2.raw } };
}

module.exports = {
  generateImageTagsFromUrl,
};
