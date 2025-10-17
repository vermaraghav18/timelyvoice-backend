// backend/src/services/x.api.js
"use strict";

const BASE = "https://api.twitter.com/2";

const token = process.env.X_BEARER_TOKEN;
if (!token) {
  console.warn("[X API] Missing X_BEARER_TOKEN in .env");
}

async function xGET(path, params = {}) {
  const usp = new URLSearchParams(params);
  const url = `${BASE}${path}?${usp.toString()}`;
  const headers = {
    authorization: `Bearer ${token}`,
    "user-agent": "TimelyVoiceBot/1.0",
  };
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`[X API] ${res.status} ${res.statusText} — ${t}`);
  }
  return res.json();
}

async function userByUsername(username) {
  username = username.replace(/^@/, "");
  return xGET(`/users/by/username/${username}`, {
    "user.fields": "id,name,username",
  });
}

async function userTweets(userId, sinceId = "") {
  const params = {
    "tweet.fields": "id,text,created_at,entities",
    max_results: 20,
    exclude: "retweets,replies",
    expansions: "attachments.media_keys,author_id",
    "media.fields": "media_key,type,url,preview_image_url",
  };
  if (sinceId) params.since_id = sinceId;
  return xGET(`/users/${userId}/tweets`, params);
}

module.exports = { userByUsername, userTweets };
