"use strict";

/**
 * X (Twitter) API + optional Nitter RSS fallback
 */

const BASE = "https://api.twitter.com/2";
const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN;

// Nitter bases are optional; used as a fallback only on 401/403/429
const NITTER_BASES = (process.env.NITTER_BASES || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

if (!X_BEARER_TOKEN) {
  console.warn("[X API] Missing X_BEARER_TOKEN in .env");
}

/* ------------ Small error helper with status passthrough ------------ */
function httpError(status, message, body) {
  const e = new Error(message || `HTTP ${status}`);
  e.status = status;
  if (body !== undefined) e.body = body;
  return e;
}

/* ------------ Core GET with proper error bubbling ------------ */
async function xGET(path, params = {}) {
  const usp = new URLSearchParams(params);
  const url = `${BASE}${path}?${usp.toString()}`;

  const headers = {
    authorization: `Bearer ${X_BEARER_TOKEN}`,
    "user-agent": "TimelyVoiceBot/1.0",
  };

  const res = await fetch(url, { headers });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    // Try to parse JSON error (X API sends structured JSON)
    try {
      const json = JSON.parse(txt);
      const msg = json?.title || json?.detail || `${res.status} ${res.statusText}`;
      throw httpError(res.status, msg, json);
    } catch {
      throw httpError(res.status, `[X API] ${res.status} ${res.statusText}`, txt);
    }
  }
  return res.json();
}

/* ------------ Public X API helpers ------------ */

async function userByUsername(username) {
  username = String(username || "").replace(/^@/, "");
  return xGET(`/users/by/username/${username}`, {
    "user.fields": "id,name,username",
  });
}

async function userTweets(userId, sinceId = "") {
  const params = {
    "tweet.fields": "id,text,created_at,entities",
    max_results: 50,
    exclude: "retweets,replies",
    expansions: "attachments.media_keys,author_id",
    "media.fields": "media_key,type,url,preview_image_url",
  };
  if (sinceId) params.since_id = sinceId;
  return xGET(`/users/${userId}/tweets`, params);
}

/* ------------ Nitter RSS fallback (optional) ------------ */
/**
 * Very small RSS parser good enough for Nitter.
 * We return a shape *similar* to userTweets() so the controllers can reuse the pipeline.
 * IDs are synthetic (timestamps-as-strings). We will NOT advance sinceId when using this fallback.
 */
function parseNitterRss(xml = "") {
  const items = [];
  const rxItem = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = rxItem.exec(xml))) {
    const block = m[1];
    const title =
      (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || [])[1] ||
      (block.match(/<title>(.*?)<\/title>/) || [])[1] ||
      "";
    const link = (block.match(/<link>(.*?)<\/link>/) || [])[1] || "";
    const pub = (block.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || "";
    items.push({ title, link, pubDate: pub });
  }
  return items;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "user-agent": "TimelyVoiceBot/1.0" },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw httpError(res.status, `Nitter ${res.status} ${res.statusText}`, t);
  }
  return res.text();
}

async function userTweetsViaNitter(handle) {
  if (!NITTER_BASES.length) {
    throw httpError(503, "No NITTER_BASES configured for fallback");
  }
  handle = String(handle || "").replace(/^@/, "");

  let lastErr;
  for (const baseRaw of NITTER_BASES) {
    const base = baseRaw.replace(/\/+$/, "");
    const url = `${base}/${handle}/rss`;
    try {
      const xml = await fetchText(url);
      const items = parseNitterRss(xml).slice(0, 30);

      // Normalize roughly like userTweets result
      const now = Date.now();
      return {
        _fallback: "nitter",
        data: items.map((it, idx) => ({
          id: String(now - idx), // synthetic id; do NOT use to update sinceId
          text: it.title || "",
          created_at: new Date(it.pubDate || now).toISOString(),
          entities: {
            urls: it.link ? [{ expanded_url: it.link }] : [],
          },
          attachments: {},
        })),
        includes: { media: [] },
      };
    } catch (e) {
      lastErr = e;
      continue; // try next base
    }
  }
  throw lastErr || httpError(502, "All Nitter bases failed");
}

module.exports = {
  userByUsername,
  userTweets,
  userTweetsViaNitter,
};
