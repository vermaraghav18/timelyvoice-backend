// Rewriter service with anti-copy guard and sanitizer using OpenRouter.
import { cleanseHtml } from "./sanitize.service.js";
import { isTooSimilar } from "./similarity.service.js";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE = process.env.OPENROUTER_BASE || "https://openrouter.ai/api/v1";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-3.5-sonnet";
const REWRITE_STRICT = String(process.env.REWRITE_STRICT || "1") === "1";

function buildSystemPrompt() {
  return [
    "You are a news rewrite engine. Your job is to create ORIGINAL text based on a source.",
    "Rules:",
    "- Do NOT copy sentences or phrases > 10 words verbatim.",
    "- No quotes unless explicitly marked as quotations and <= 10 words each.",
    "- Write in neutral, concise newsroom style.",
    "- Keep facts, numbers, names accurate; do not invent.",
    "- Produce JSON with fields: title, summary, bodyHtml, keywords.",
    "- Title: <= 70 chars, no clickbait, no colon chains.",
    "- Summary: 40–70 words, one paragraph.",
    "- BodyHtml: 3–6 short <p> paragraphs, no inline styles, no iframes, no buttons.",
    "- Add 3–8 keywords (comma-separated), lowercase."
  ].join("\n");
}

function buildUserPrompt(blob) {
  const { url = "", title = "", description = "", content = "", category = "", tags = [] } = blob || {};
  return [
    `Source URL: ${url}`,
    `Source Title: ${title}`,
    `Source Description: ${description}`,
    category ? `Category: ${category}` : "",
    tags?.length ? `Tags: ${tags.join(", ")}` : "",
    "Source Body (may be empty):",
    content || "(no body)",
    "",
    "Task: Rewrite as per rules. Do not copy. Output JSON only."
  ].filter(Boolean).join("\n");
}

async function callOpenRouter(messages) {
  if (!OPENROUTER_API_KEY) throw new Error("Missing OPENROUTER_API_KEY");

  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      temperature: 0.5,
    })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${txt}`);
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content || "";
  return content;
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function asPlainText(o) {
  const join = [o?.title || "", o?.summary || "", o?.bodyHtml || ""].join(" ");
  return join.replace(/<[^>]+>/g, " ");
}

export async function rewriteWithGuard(source) {
  if (!REWRITE_STRICT) {
    const passthrough = {
      title: source.title || "",
      summary: source.description || "",
      bodyHtml: cleanseHtml(source.content || source.description || ""),
      keywords: "",
    };
    return passthrough;
  }

  const sys = buildSystemPrompt();
  let user = buildUserPrompt(source);
  let attempts = 0;
  let last = null;
  let best = null;
  const sourcePlain = [source.title || "", source.description || "", (source.content || "").replace(/<[^>]+>/g," ")].join(" ");

  while (attempts < 3) {
    attempts++;
    const content = await callOpenRouter([
      { role: "system", content: sys },
      { role: "user", content: user },
    ]);

    let parsed = safeJsonParse(content);
    if (!parsed) {
      const first = content.indexOf("{");
      const lastIdx = content.lastIndexOf("}");
      if (first >= 0 && lastIdx > first) parsed = safeJsonParse(content.slice(first, lastIdx + 1));
    }
    if (!parsed) throw new Error("Model did not return JSON");

    parsed.bodyHtml = cleanseHtml(parsed.bodyHtml || "");

    const plain = asPlainText(parsed);
    const { tooSimilar, score } = isTooSimilar(plain, sourcePlain, 0.25);
    last = { parsed, score };

    if (!tooSimilar) {
      best = parsed;
      break;
    }

    const penalty = topOverlaps(plain, sourcePlain);
    user = buildUserPrompt(source) + "\n\nRegenerate with stronger paraphrasing. Avoid phrases: " + penalty.join(", ");
  }

  if (best) return best;
  return last?.parsed || {
    title: source.title || "",
    summary: source.description || "",
    bodyHtml: cleanseHtml(source.content || source.description || ""),
    keywords: "",
  };
}

function topOverlaps(a, b) {
  const toksA = a.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const toksB = b.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const grams = (t) => {
    const out = [];
    for (let i = 0; i < t.length - 2; i++) out.push(t.slice(i, i+3).join(" "));
    return out;
  };
  const A = grams(toksA);
  const Bset = new Set(grams(toksB));
  const hits = new Map();
  for (const g of A) if (Bset.has(g)) hits.set(g, (hits.get(g) || 0) + 1);
  return Array.from(hits.entries()).sort((x,y)=>y[1]-x[1]).slice(0,8).map(x=>x[0]);
}
