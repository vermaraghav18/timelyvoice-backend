// backend/src/services/liveNewsIngestor.js
"use strict";

/**
 * Live News Ingestor — TODAY-ONLY VERSION
 * ---------------------------------------
 * This version:
 * ✔ Handles broken RSS timestamps correctly
 * ✔ Keeps ONLY stories whose publishedAt date is TODAY (server local time)
 * ✔ Still removes 2023/2022 etc. stories
 * ✔ Removes duplicate stories
 * ✔ Removes promo / live blog / opinion junk
 * ✔ Sorts newest → oldest
 * ✔ If nothing is left for today, returns [] so AI falls back to generic mode
 */

const Parser = require("rss-parser");
const rssParser = new Parser({ timeout: 8000 });

// ✅ NEW: extract publisher/RSS image (media/enclosure/og:image)
const { extractSourceImage } = require("./sourceImageExtractor");


// -----------------------------------------------------------------------------
// FEEDS
// -----------------------------------------------------------------------------
const FEEDS = [
  // ─────────────────────────────
  // Times of India
  // ─────────────────────────────
  "https://timesofindia.indiatimes.com/rssfeedstopstories.cms",

  // ─────────────────────────────
  // Hindustan Times 
  // ─────────────────────────────
  "https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml",

   // ─────────────────────────────
  // NDTV
  // ─────────────────────────────
  "https://feeds.feedburner.com/ndtvnews-top-stories",
  "https://feeds.feedburner.com/ndtvcooks-latest",

   // ─────────────────────────────
  // tribune
  // ─────────────────────────────
  "https://publish.tribuneindia.com/newscategory/india/feed/",
  "https://publish.tribuneindia.com/newscategory/sports/feed/",


  // ─────────────────────────────
  // EuroAsiaNet
  // ─────────────────────────────
  "https://rss.app/feeds/HiK5vx8hyCAt4cBp.xml",


  // Google News (World) via RSS.app
  "https://rss.app/feeds/utwHGNw8064jpf6G.xml",


];

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------
function clean(s = "") {
  return String(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function parseDate(item) {
  const fields = [
    item.isoDate,
    item.pubDate,
    item.pubdate,
    item["dc:date"],
    item.updated,
    item.published,
    item.date,
  ];

  for (const f of fields) {
    if (!f) continue;
    const d = new Date(f);
    if (!isNaN(d.getTime())) return d;
  }

  // Fail safe: treat as *old*, not new
  return null;
}

function isOldYear(title) {
  const match = title.match(/(20\d{2})/);
  if (!match) return false;
  const year = parseInt(match[1], 10);
  const current = new Date().getFullYear();
  return year < current;
}

// Title-based fallback categorization
function guessCategoryFromTitle(title = "") {
  const t = title.toLowerCase();

  if (t.includes("gdp") || t.includes("rbi") || t.includes("market"))
    return "Business";
  if (t.includes("modi") || t.includes("cabinet") || t.includes("parliament"))
    return "India";
  if (t.includes("weather") || t.includes("climate")) return "Science";
  if (t.includes("cricket") || t.includes("football")) return "Sports";
  if (t.includes("ai") || t.includes("tech")) return "Tech";
  return "World";
}

// Feed → category mapping (with fallback to title)
function guessCategory(url = "", title = "") {
  const u = url.toLowerCase();

  // Times of India — tune per feed
  if (u.includes("timesofindia.indiatimes.com/rssfeedstopstories.cms")) {
    return "Politics"; // general India-focused top stories
  }
  if (u.includes("timesofindia.indiatimes.com/rssfeeds/1898055.cms")) {
    return "Business";
  }
  if (u.includes("timesofindia.indiatimes.com/rssfeeds/1081479906.cms")) {
    return "Sports";
  }
  if (u.includes("timesofindia.indiatimes.com/rssfeeds/4719148.cms")) {
    return "Entertainment";
  }
  if (u.includes("timesofindia.indiatimes.com/rssfeeds/-2128936835.cms")) {
    return "World";
  }
  if (u.includes("timesofindia.indiatimes.com/rssfeeds/296589292.cms")) {
    return "World";
  }

  // Indian Express section-based feeds
  if (u.includes("indianexpress.com/section/business/")) {
    return "Business";
  }
  if (u.includes("indianexpress.com/section/sports/")) {
    return "Sports";
  }
  if (u.includes("indianexpress.com/section/entertainment/")) {
    return "Entertainment";
  }
  if (u.includes("indianexpress.com/section/news-today/")) {
    return "Politics";
  }
  if (u.includes("indianexpress.com/section/trending/")) {
    return "World";
  }

  // RSS.app feeds — treat as global / mixed news
  if (u.includes("rss.app/feeds/")) {
    return "World";
  }

  // Fallback: infer from title text
  return guessCategoryFromTitle(title);
}

function isBadStory(title, summary) {
  const t = title.toLowerCase();
  const s = summary.toLowerCase();

  const junk = ["opinion", "editorial", "newsletter", "blog", "live blog"];
  return junk.some((x) => t.includes(x) || s.includes(x));
}

// Local yyyy-mm-dd based on server timezone
function localDateKey(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// -----------------------------------------------------------------------------
// FETCH ONE FEED
// -----------------------------------------------------------------------------
async function fetchFeed(url) {
  try {
    const feed = await rssParser.parseURL(url);
    const feedTitle = clean(feed.title || "");

    // ✅ We need async extraction (RSS media/enclosure + OG fallback), so Promise.all
    const mapped = await Promise.all(
      (feed.items || []).map(async (item) => {
        const title = clean(item.title || "");

        const rawSummary =
          item.contentSnippet || item.summary || item.description || "";
        const summaryClean = clean(rawSummary);
        const summary = summaryClean || title;

        const publishedAt = parseDate(item);

        // ✅ Extract original/publisher image
        const { url: sourceImageUrl, from: sourceImageFrom } =
          await extractSourceImage(item);

        return {
          title,
          summary,
          link: item.link || "",
          category: guessCategory(url, title),
          feedUrl: url,
          feedTitle,
          sourceName: feedTitle || url,
          publishedAt,

          // ✅ NEW fields used by Admin UI side-by-side compare
          sourceImageUrl: sourceImageUrl || "",
          sourceImageFrom: sourceImageFrom || "",
        };
      })
    );

    return mapped;
  } catch (err) {
    console.error("[liveNewsIngestor] FEED ERROR:", url, err.message);
    return [];
  }
}


// -----------------------------------------------------------------------------
// FILTER STORIES — ONLY TODAY'S DATE
// -----------------------------------------------------------------------------
function filterStories(stories) {
  const now = new Date();
  const todayKey = localDateKey(now);
  const maxAgeMs = 24 * 60 * 60 * 1000; // safety net

  return stories.filter((s) => {
    if (!s.title || !s.link) return false;

    if (isOldYear(s.title)) return false;

    if (isBadStory(s.title, s.summary)) return false;

    if (!(s.publishedAt instanceof Date)) return false;

    const storyKey = localDateKey(s.publishedAt);
    if (!storyKey) return false;

    // ✅ HARD RULE: must be same calendar date as "today" in server timezone
    if (storyKey !== todayKey) return false;

    // Optional safety: still keep within 24h window and avoid future timestamps
    const age = now.getTime() - s.publishedAt.getTime();
    if (age < 0) return false; // future timestamps → ignore
    if (age > maxAgeMs) return false; // older than 24h → ignore

    return true;
  });
}

// -----------------------------------------------------------------------------
// DEDUPE
// -----------------------------------------------------------------------------
function dedupe(stories) {
  const map = new Map();
  for (const s of stories) {
    const key = (s.link + "|" + s.title).toLowerCase();
    if (!map.has(key)) map.set(key, s);
  }
  return [...map.values()];
}

// -----------------------------------------------------------------------------
// MAIN FUNCTION
// -----------------------------------------------------------------------------
async function fetchLiveSeeds(limit = 10) {
  const all = [];

  for (const url of FEEDS) {
    // Sequential ensures we don’t flood RSS servers
    /* eslint-disable no-await-in-loop */
    const items = await fetchFeed(url);
    all.push(...items);
  }

  if (!all.length) {
    console.warn("[liveNewsIngestor] No items fetched from any feed.");
    return [];
  }

  let filtered = dedupe(all);
  filtered = filterStories(filtered);

  if (!filtered.length) {
    console.warn(
      "[liveNewsIngestor] All items got filtered out for TODAY. " +
        "Returning [] so AI falls back to generic current-news mode."
    );
    // Return [] → aiNewsGenerator will still generate plausible current
    // articles using its no-RSS fallback, without being anchored to old dates.
    return [];
  }

  // Sort newest → oldest
  filtered.sort((a, b) => b.publishedAt - a.publishedAt);

  return filtered.slice(0, limit);
}

module.exports = {
  fetchLiveSeeds,
};
