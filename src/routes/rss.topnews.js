// backend/src/routes/rss.topnews.js

const express = require("express");
const router = express.Router();
const Article = require("../models/Article");

// Base URL for links in RSS items
const FRONTEND_BASE_URL =
  (process.env.FRONTEND_BASE_URL ||
    process.env.SITE_URL ||
    "https://timelyvoice.com").replace(/\/$/, "");
const SITE_URL = FRONTEND_BASE_URL;

// Minimal XML escape
function esc(s = "") {
  return String(s).replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case '"':
        return "&quot;";
      case "'":
        return "&apos;";
      default:
        return c;
    }
  });
}

function articleUrlFromSlug(slug) {
  if (!slug) return SITE_URL;
  return `${SITE_URL}/article/${encodeURIComponent(slug)}`;
}

function guessMimeFromUrl(url = "") {
  const u = url.toLowerCase();
  if (u.endsWith(".webp")) return "image/webp";
  if (u.endsWith(".png")) return "image/png";
  if (u.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

// Shared handler for both /top-news and /top-news.xml
async function handleTopNewsRss(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 100);
    const now = new Date();

    // Visibility rules similar to public APIs:
    // - status = published
    // - publishAt or publishedAt <= now OR both missing
    const rows = await Article.find({
      status: "published",
      $or: [
        { publishedAt: { $lte: now } },
        { publishAt:   { $lte: now } },
        {
          $and: [
            { publishedAt: { $exists: false } },
            { publishAt:   { $exists: false } },
          ],
        },
      ],
    })
      .select(
        "title slug summary publishedAt publishAt updatedAt createdAt imageUrl ogImage cover"
      )
      .sort({
        publishedAt: -1,
        publishAt: -1,
        createdAt: -1,
        _id: -1,
      })
      .limit(limit)
      .lean();

    const nowStr = new Date().toUTCString();

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>The Timely Voice — Top News</title>
  <link>${esc(SITE_URL + "/top-news")}</link>
  <description>Newest headlines from The Timely Voice</description>
  <language>en</language>
  <lastBuildDate>${esc(nowStr)}</lastBuildDate>
`;

    for (const a of rows) {
      const link = articleUrlFromSlug(a.slug);
      const pub =
        a.publishedAt || a.publishAt || a.updatedAt || a.createdAt || new Date();
      const pubDate = new Date(pub).toUTCString();
      const desc = a.summary || "";

      // choose best image (order: ogImage > imageUrl > cover)
      const img = a.ogImage || a.imageUrl || a.cover || "";
      const mime = img ? guessMimeFromUrl(img) : null;

      xml += `  <item>
    <title>${esc(a.title || "")}</title>
    <link>${esc(link)}</link>
    <guid isPermaLink="true">${esc(link)}</guid>
    <pubDate>${esc(pubDate)}</pubDate>
    <description><![CDATA[${desc}]]></description>
`;

      if (img) {
        xml += `    <enclosure url="${esc(img)}" type="${esc(mime)}" />
`;
      }

      xml += `  </item>
`;
    }

    xml += `</channel>
</rss>`;

    res.set("Content-Type", "application/rss+xml; charset=utf-8");
    // Shorter cache so new posts appear faster in readers
    res.set("Cache-Control", "public, max-age=60");
    res.status(200).send(xml);
  } catch (err) {
    console.error("[RSS] /rss/top-news error:", err);
    next(err);
  }
}

// Support both /rss/top-news and /rss/top-news.xml
router.get("/top-news", handleTopNewsRss);
router.get("/top-news.xml", handleTopNewsRss);

module.exports = router;
