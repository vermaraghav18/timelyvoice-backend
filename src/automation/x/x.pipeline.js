// src/automation/x/x.pipeline.js
import slugify from "slugify";

// Models (hybrid import)
import ArticlePkg from "../../models/Article.js";
const Article = ArticlePkg.default || ArticlePkg;

import XItemPkg from "../../models/XItem.js";
const XItem = XItemPkg.default || XItemPkg;

const ALLOWED_CATEGORIES = ["Politics", "World", "Sports"];
const PUBLISH_MODE = (process.env.AUTOMATION_PUBLISH_MODE || "draft").toLowerCase(); // "draft" | "publish"

/* -------------------- helpers -------------------- */
function countWords(s = "") {
  return String(s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

async function uniqueSlugForTitle(title = "article") {
  const base = slugify(String(title || "article"), { lower: true, strict: true }) || "article";
  let s = base;
  let i = 2;
  while (await Article.exists({ slug: s })) s = `${base}-${i++}`;
  return s;
}

function getFirstImageUrl(media = [], fallback = "") {
  for (const m of media || []) {
    if (typeof m === "string" && /^https?:\/\//i.test(m)) return m;
    if (m && typeof m === "object" && typeof m.url === "string" && /^https?:\/\//i.test(m.url)) {
      return m.url;
    }
  }
  return fallback || null;
}

// Strip code fences/backticks so JSON.parse doesn’t choke
function extractJsonLike(text = "") {
  const t = String(text || "")
    .replace(/```json\s*([\s\S]*?)```/gi, "$1")
    .replace(/```\s*([\s\S]*?)```/gi, "$1")
    .trim();
  try { return JSON.parse(t); } catch (_) {}
  const m = t.match(/\{[\s\S]*\}$/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return {};
}

async function openrouterChat({ prompt, model, maxTokens, temperature = 0.4 }) {
  const apiKey = (process.env.OPENROUTER_API_KEY_AUTOMATION || process.env.OPENROUTER_API_KEY || "").trim();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY missing");

  const body = {
    model: model || process.env.OPENROUTER_MODEL_AUTOMATION || process.env.OPENROUTER_MODEL_XGEN || "openai/gpt-4o-mini",
    messages: [
      { role: "system", content: "You are a factual newsroom editor converting tweets into concise, neutral articles. Follow instructions exactly." },
      { role: "user", content: prompt }
    ],
    max_tokens: Number(process.env.XGEN_MAX_TOKENS || maxTokens || 1800),
    temperature,
  };

  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.SITE_URL || "http://localhost",
      "X-Title": "TimelyVoice Automation",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`OpenRouter ${r.status}: ${txt.slice(0, 300)}`);
  }
  const data = await r.json().catch(() => ({}));
  return data?.choices?.[0]?.message?.content || "";
}

async function expandToWords({ body, targetMin = 520, maxTries = 3 }) {
  let current = String(body || "").trim();
  for (let i = 0; i < maxTries && countWords(current) < targetMin; i++) {
    const expandPrompt = `
The following is a news article body. Expand it with additional factual, neutral reporting, context, and quotes-style paraphrases if needed so that the TOTAL length is between ${targetMin} and 600 words.
Maintain style and coherence. Output ONLY the full expanded body (no JSON, no headers, no backticks).

---
${current}
---`;
    const more = await openrouterChat({ prompt: expandPrompt, temperature: 0.2, maxTokens: 1200 });
    const next = String(more || "").trim();
    if (countWords(next) > Math.max(120, countWords(current) * 0.5)) current = next;
    else if (next) current = `${current}\n\n${next}`;
    current = current.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  return current;
}

/* -------------------- main -------------------- */
export async function processNewTweets({ limit = 20 } = {}) {
  const batch = await XItem.find({ status: "new" }).sort({ tweetedAt: 1 }).limit(limit);
  if (!batch.length) return { processed: 0, skipped: 0, errors: 0 };

  let processed = 0, skipped = 0, errors = 0;

  for (const tweet of batch) {
    try {
      tweet.status = "processing";
      await tweet.save();

      const rawText = String(tweet.text || "").trim();
      if (countWords(rawText) < 6 || rawText.length < 30) {
        tweet.status = "error";
        tweet.error  = "SKIP_TOO_SHORT";
        await tweet.save();
        skipped++; continue;
      }

      const prompt = `
Convert the tweet below into a publishable news article.

Tweet:
"""
${rawText}
"""

STRICT REQUIREMENTS:
- "category" must be one of exactly: Politics, World, Sports
- "summary" must be 80–90 words
- "body" must be 500–600 words (prefer 520–580)
- Neutral, factual newsroom style
- Output VALID JSON ONLY (no markdown, no backticks), with keys: category, summary, body
`;

      const raw = await openrouterChat({ prompt, temperature: 0.4 });
      const parsed = extractJsonLike(raw);

      let category = String(parsed.category || "").trim();
      if (!ALLOWED_CATEGORIES.includes(category)) category = "Politics";

      let summary = String(parsed.summary || "").trim();
      let body    = String(parsed.body || "").trim();

      if (countWords(body) < 520 && body) body = await expandToWords({ body, targetMin: 520, maxTries: 3 });

      if (countWords(body) < 480) {
        const tail = await openrouterChat({
          prompt: `Continue the article below with additional neutral context until the TOTAL reaches ~520–580 words. Output ONLY the continuation paragraphs (no headings, no JSON, no backticks).\n\n---\n${body}\n---`,
          temperature: 0.3,
          maxTokens: 600
        });
        const cont = String(tail || "").trim();
        if (cont) body = `${body}\n\n${cont}`.trim();
      }

      if (countWords(body) < 420) throw new Error("Model body too short");

      const sWords = summary.split(/\s+/).filter(Boolean);
      if (sWords.length > 95) summary = sWords.slice(0, 90).join(" ");

      const title = rawText.slice(0, 120).replace(/\s+/g, " ").trim() || "Update";
      const slug  = await uniqueSlugForTitle(title);

      const fallbackId = process.env.AUTOMATION_DEFAULT_IMAGE_ID || "";
      const imageUrl   = getFirstImageUrl(tweet.media, tweet.image) || fallbackId;

      const now = new Date();
      await Article.create({
        title,
        slug,
        summary,
        body,
        category,
        author: "Desk",
        status: PUBLISH_MODE === "publish" ? "published" : "draft",
        publishAt: PUBLISH_MODE === "publish" ? now : null,
        publishedAt: PUBLISH_MODE === "publish" ? now : null,
        imageUrl,
        sourceHandle: tweet.handle || "",
        sourceId: tweet.xId || "",
        readingTime: Math.max(1, Math.round(countWords(body) / 200)),
      });

      tweet.status = "published"; // queue item completed
      tweet.error = "";
      await tweet.save();
      processed++;
    } catch (err) {
      console.error("[X] processNewTweets failed:", err?.message || err);
      try {
        tweet.status = "error";
        tweet.error  = String(err?.message || err);
        await tweet.save();
      } catch (_) {}
      errors++;
    }
  }

  return { processed, skipped, errors };
}
