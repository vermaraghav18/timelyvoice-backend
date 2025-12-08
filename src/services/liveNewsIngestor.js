// backend/src/services/liveNewsIngestor.js
"use strict";

/**
 * Live News Ingestor
 * ------------------
 * Fetches REAL current news from RSS feeds and returns
 * lightweight “seed stories” for the AI to rewrite.
 *
 * We NEVER copy full article bodies (copyright safe).
 * We ONLY use title + summary + link + timestamp.
 */

const Parser = require("rss-parser");
const rssParser = new Parser({
  timeout: 10000,
});

// 🔗 Fixed list of feeds (you can edit later if you want)
const FEEDS = [
  // ---- India / National ----
  "https://www.thehindu.com/news/feeder/default.rss",
  "https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml",


  // ---- World ----
  "https://indianexpress.com/feed/",
  "https://www.hindustantimes.com/feeds/rss/world-news/rssfeed.xml",
 

  // ---- Business / Economy ----
 "https://economictimes.indiatimes.com/rssfeedstopstories.cms",
 "https://www.livemint.com/rss/money",

  // ---- Government of India ----

];

/**
 * Simple text cleaner (remove HTML + collapse spaces)
 */
function clean(s = "") {
  return String(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Rough category guess based on title keywords.
 * This just helps us map feeds to your Article categories.
 */
function guessCategory(title = "") {
  const t = title.toLowerCase();

  if (
    t.includes("india") ||
    t.includes("delhi") ||
    t.includes("modi") ||
    t.includes("parliament") ||
    t.includes("assembly")
  ) {
    return "India";
  }
  if (
    t.includes("rbi") ||
    t.includes("market") ||
    t.includes("stock") ||
    t.includes("bank") ||
    t.includes("gdp") ||
    t.includes("inflation")
  ) {
    return "Business";
  }
  if (
    t.includes("tech") ||
    t.includes("ai") ||
    t.includes("startup") ||
    t.includes("software") ||
    t.includes("app")
  ) {
    return "Tech";
  }
  if (
    t.includes("election") ||
    t.includes("government") ||
    t.includes("cabinet") ||
    t.includes("policy")
  ) {
    return "Politics";
  }
  if (
    t.includes("climate") ||
    t.includes("environment") ||
    t.includes("weather") ||
    t.includes("pollution")
  ) {
    return "Science";
  }
  if (
    t.includes("match") ||
    t.includes("tournament") ||
    t.includes("cricket") ||
    t.includes("football") ||
    t.includes("world cup")
  ) {
    return "Sports";
  }

  return "World";
}

/**
 * Fetch and normalise a single RSS feed.
 */
async function fetchFeed(url) {
  try {
    const feed = await rssParser.parseURL(url);

    return (feed.items || []).map((item) => {
      const title = clean(item.title || "");
      const summary = clean(
        item.contentSnippet || item.summary || item.description || ""
      );

      const publishedRaw =
        item.isoDate ||
        item.pubDate ||
        item.pubdate ||
        item["dc:date"] ||
        new Date().toISOString();

      const publishedAt = new Date(publishedRaw);

      return {
        source: "rss",
        feedTitle: feed.title || "",
        feedUrl: url,
        originSite: feed.link || "",
        link: item.link || "",
        title,
        summary,
        publishedAt,
        category: guessCategory(title),
      };
    });
  } catch (err) {
    console.error(
      "[liveNewsIngestor] failed to fetch feed",
      url,
      "error=",
      err?.message || err
    );
    return [];
  }
}

/**
 * Remove duplicate stories using (title + link) as key.
 */
function dedupe(stories) {
  const seen = new Set();
  const out = [];

  for (const s of stories) {
    const key = `${(s.link || "").toLowerCase()}|${(s.title || "").toLowerCase()}`;
    if (!key.trim()) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }

  return out;
}

/**
 * Fetch a pool of live seeds.
 *
 * limit: how many seeds to return (max).
 */
async function fetchLiveSeeds(limit = 10) {
  const all = [];

  for (const url of FEEDS) {
    // eslint-disable-next-line no-await-in-loop
    const items = await fetchFeed(url);
    all.push(...items);
  }

  if (!all.length) {
    console.warn("[liveNewsIngestor] no stories fetched from any feed");
    return [];
  }

  let filtered = dedupe(all);

  // Sort newest → oldest
  filtered.sort(
    (a, b) =>
      (b.publishedAt ? b.publishedAt.getTime() : 0) -
      (a.publishedAt ? a.publishedAt.getTime() : 0)
  );

  if (filtered.length > limit) {
    filtered = filtered.slice(0, limit);
  }

  return filtered;
}

module.exports = {
  fetchLiveSeeds,
};
