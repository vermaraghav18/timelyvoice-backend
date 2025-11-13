// backend/src/routes/rss.topnews.js
const router = require("express").Router();
const Article = require("../models/Article");

const FRONTEND_BASE_URL =
  process.env.FRONTEND_BASE_URL || "https://timelyvoice.com";
const SITE_URL = FRONTEND_BASE_URL.replace(/\/$/, "");

// minimal XML escape
function esc(s = "") {
  return String(s).replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case '"': return "&quot;";
      case "'": return "&apos;";
      default:  return c;
    }
  });
}

function articleUrlFromSlug(slug) {
  if (!slug) return SITE_URL;
  return `${SITE_URL}/article/${slug}`;
}

function guessMimeFromUrl(url = "") {
  const u = url.toLowerCase();
  if (u.endsWith(".webp")) return "image/webp";
  if (u.endsWith(".png"))  return "image/png";
  if (u.endsWith(".gif"))  return "image/gif";
  return "image/jpeg";
}

router.get("/top-news.xml", async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 100);

    const rows = await Article.find({
      status: "published",
      publishedAt: { $ne: null },
    })
      // 👇 NOTE: include image fields now
      .select("title slug summary publishedAt updatedAt createdAt imageUrl ogImage cover")
      .sort({ publishedAt: -1, updatedAt: -1, createdAt: -1 })
      .limit(limit)
      .lean();

    const now = new Date().toUTCString();

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>The Timely Voice — Top News</title>
  <link>${SITE_URL}/top-news</link>
  <description>Newest headlines from The Timely Voice</description>
  <language>en</language>
  <lastBuildDate>${now}</lastBuildDate>
`;

    for (const a of rows) {
      const link = articleUrlFromSlug(a.slug);
      const pub =
        a.publishedAt || a.updatedAt || a.createdAt || new Date();
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

      // 🔹 Add enclosure only if we have an image
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
    res.set("Cache-Control", "public, max-age=300");
    res.status(200).send(xml);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
