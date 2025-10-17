"use strict";

// Node 18+ has global fetch; polyfill if not
const fetch = global.fetch || require("node-fetch");

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";

console.log("[OpenRouter] global model =", process.env.OPENROUTER_MODEL);
console.log("[OpenRouter] xgen model   =", process.env.OPENROUTER_MODEL_XGEN);

/**
 * Call OpenRouter to generate a strict JSON draft for an article.
 * Throws if API key is missing or request fails. No silent fallbacks.
 */
async function generateJSONDraft({ tweetText, extractText, defaults, sources, model }) {
  const apiKeyRaw = process.env.OPENROUTER_API_KEY;
  const apiKey = (apiKeyRaw || "").trim();

  if (!apiKey) {
    // Make the failure obvious so you don't think the LLM ran
    throw new Error("OpenRouter API key missing in env (OPENROUTER_API_KEY).");
  }

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

  const content = `
TWEET:
${tweetText || "(none)"}

VERIFIED SOURCES:
${(sources || []).map(s => `- ${s.url}`).join("\n") || "(none)"}

EXTRACTED TEXT (from official pages):
${extractText || "(none)"}

DEFAULTS:
author=${defaults?.author}, category=${defaults?.category}, publishAt=${defaults?.publishAt}, geo.mode=${defaults?.geo?.mode}
`.trim();

  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.SITE_URL || "http://localhost",
      "X-Title": "TimelyVoice Admin",
    },
    body: JSON.stringify({
      model: useModel,
      temperature: 0.2,
      response_format: { type: "json_object" }, // ask for tool-JSON-like formatting
      messages: [
        { role: "system", content: sys },
        { role: "user", content }
      ],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`[OpenRouter] ${res.status} ${res.statusText} — ${t}`);
  }

  // Try to parse safely
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content ?? "";
  let jsonStr = raw;

  // In case the model wrapped it in markdown or added preface, extract the last {...}
  if (typeof raw === "string") {
    const match = raw.match(/\{[\s\S]*\}$/);
    if (match) jsonStr = match[0];
  }

  let out;
  try {
    out = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`[OpenRouter] JSON parse failed: ${e.message}. Raw: ${String(raw).slice(0, 400)}...`);
  }

  return out;
}

module.exports = { generateJSONDraft };
