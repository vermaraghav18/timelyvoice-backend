// backend/src/routes/sitemap.js
const express = require("express");
const dayjs = require("dayjs");

/* -------------------------------------------
   Model injection
-------------------------------------------- */
let Models = { Article: null, Category: null, Tag: null };
function setModels({ Article, Category, Tag }) {
  Models.Article = Article;
  Models.Category = Category;
  Models.Tag = Tag;
}

/* -------------------------------------------
   Simple cache & invalidation
-------------------------------------------- */
const cache = {
  xml: null, // standard sitemap
  news: null, // google news sitemap
  lastBuiltXml: 0,
  lastBuiltNews: 0,
  dirty: true,
};
function markSitemapDirty() {
  cache.dirty = true;
}

/* -------------------------------------------
   Utils
-------------------------------------------- */
const ORIGIN = (
  process.env.FRONTEND_BASE_URL ||
  process.env.SITE_URL ||
  "https://timelyvoice.com"
)
  .replace(/\/+$/, "")
  .replace(/^http:\/\//, "https://");

const PUBLICATION_NAME = process.env.PUBLICATION_NAME || "The Timely Voice";
const PUBLICATION_LANGUAGE = process.env.PUBLICATION_LANGUAGE || "en";

function xmlEscape(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/* -------------------------------------------
   Build main sitemap data (uses injected Models)
-------------------------------------------- */
async function buildAllUrls(origin) {
  if (!Models.Category || !Models.Article || !Models.Tag) {
    throw new Error(
      "Sitemap models not set. Call setModels({ Article, Category, Tag }) before mounting the router."
    );
  }

  // Categories (for /category/:slug)
  const categories = await Models.Category.find({}, { slug: 1, updatedAt: 1 }).lean();

  // Tags (for /tag/:slug)
  // We still load tags if needed for other logic, but we no longer
  // include tag listing pages in the sitemap because they are NOINDEX
  // and tend to create duplicate/low-value clusters.
  const tags = await Models.Tag.find({}, { slug: 1, updatedAt: 1 }).lean();
  // tags currently unused on purpose (we keep tag listing pages out)

  // Articles (only published + visible by schedule)
  const now = new Date();

  const articles = await Models.Article.find(
    {
      status: "published",
      // treat publishedAt as the real publish time
      $or: [
        { publishedAt: { $lte: now } },
        { publishedAt: { $exists: false } },
        { publishedAt: null },
      ],
    },
    { slug: 1, updatedAt: 1, publishAt: 1, publishedAt: 1, title: 1 }
  )
    .sort({ publishedAt: -1, updatedAt: -1, _id: -1 })
    .lean();

  // Core urls (homepage + key static pages)
  const core = [
    // Home
    { loc: origin, changefreq: "hourly", priority: "1.0" },

    // Key sections
    { loc: `${origin}/top-news`, changefreq: "hourly", priority: "0.9" },

    // Trust / policy pages (important for Google Ads & E-E-A-T)
    { loc: `${origin}/about`, changefreq: "yearly", priority: "0.4" },
    { loc: `${origin}/contact`, changefreq: "yearly", priority: "0.4" },
    {
      loc: `${origin}/editorial-policy`,
      changefreq: "yearly",
      priority: "0.3",
    },
    { loc: `${origin}/corrections`, changefreq: "yearly", priority: "0.3" },
    { loc: `${origin}/privacy-policy`, changefreq: "yearly", priority: "0.3" },
    { loc: `${origin}/terms`, changefreq: "yearly", priority: "0.3" },
    { loc: `${origin}/advertising`, changefreq: "yearly", priority: "0.3" },
  ];

  // Categories -> /category/:slug
  const catUrls = categories.map((c) => ({
    loc: `${origin}/category/${encodeURIComponent(c.slug)}`,
    lastmod: (c.updatedAt || new Date()).toISOString(),
    changefreq: "daily",
    priority: "0.6",
  }));

  // Tags -> /tag/:slug
  // Intentionally not included in sitemap (thin/duplicate risk)
  const tagUrls = []; // eslint-disable-line no-unused-vars

  // Articles -> /article/:slug  (prefer updatedAt → publishedAt → publishAt)
  const articleUrls = articles.map((a) => {
    const last = a.updatedAt || a.publishedAt || a.publishAt || new Date();
    return {
      loc: `${origin}/article/${encodeURIComponent(a.slug)}`,
      lastmod: new Date(last).toISOString(),
      changefreq: "weekly",
      priority: "0.8",
    };
  });

  // Only core, categories, and articles should be indexed
  return [...core, ...catUrls, ...articleUrls];
}

function urlsToXml(urls) {
  const items = urls
    .map(
      (u) => `
  <url>
    <loc>${xmlEscape(u.loc)}</loc>
    ${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}
    ${u.changefreq ? `<changefreq>${u.changefreq}</changefreq>` : ""}
    ${u.priority ? `<priority>${u.priority}</priority>` : ""}
  </url>`
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset
  xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
>
${items}
</urlset>`;
}

/* -------------------------------------------
   Google News sitemap (last 48h)
-------------------------------------------- */
async function buildNewsXml(origin) {
  if (!Models.Article) {
    throw new Error(
      "Sitemap models not set. Call setModels({ Article, Category, Tag }) before mounting the router."
    );
  }

  const now = new Date();
  const twoDaysAgo = dayjs(now).subtract(48, "hour").toDate();

  // Base visibility: published and not in the future (publishAt)
  const baseVisibility = {
    status: "published",
    $or: [
      { publishAt: { $lte: now } },
      { publishAt: { $exists: false } },
      { publishAt: null },
    ],
  };

  // Recent window: last 48h by publishedAt (fallback to createdAt)
  const recentWindow = {
    $or: [
      { publishedAt: { $gte: twoDaysAgo } },
      {
        $and: [
          { publishedAt: { $exists: false } },
          { createdAt: { $gte: twoDaysAgo } },
        ],
      },
    ],
  };

  const query = {
    ...baseVisibility,
    ...recentWindow, // merge – different keys so no override
  };

  const articles = await Models.Article.find(
    query,
    { slug: 1, title: 1, publishedAt: 1, updatedAt: 1, createdAt: 1 }
  )
    .sort({ publishedAt: -1, createdAt: -1 })
    .limit(200) // Google News: only last ~48h; 200 is safe
    .lean();

  const items = articles
    .map((a) => {
      const pubDate = a.publishedAt || a.createdAt || new Date();
      const updDate = a.updatedAt || pubDate;
      const pubIso = new Date(pubDate).toISOString();
      const lastIso = new Date(updDate).toISOString();
      const loc = `${origin}/article/${encodeURIComponent(a.slug)}`;

      return `
  <url>
    <loc>${xmlEscape(loc)}</loc>
    <lastmod>${lastIso}</lastmod>
    <news:news>
      <news:publication>
        <news:name>${xmlEscape(PUBLICATION_NAME)}</news:name>
        <news:language>${xmlEscape(PUBLICATION_LANGUAGE)}</news:language>
      </news:publication>
      <news:publication_date>${pubIso}</news:publication_date>
      <news:title>${xmlEscape(a.title || "Article")}</news:title>
    </news:news>
  </url>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset
  xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
${items}
</urlset>`;
}

/* -------------------------------------------
   Router
-------------------------------------------- */
const router = express.Router();

/**
 * GET /sitemap.xml
 */
router.get("/sitemap.xml", async (req, res, next) => {
  try {
    const now = Date.now();
    const maxAgeMs = 5 * 60 * 1000; // 5 min

    if (
      !cache.dirty &&
      cache.xml &&
      now - cache.lastBuiltXml < maxAgeMs
    ) {
      res.setHeader(
        "Cache-Control",
        "public, max-age=300, s-maxage=1200, stale-while-revalidate=3600"
      );
      res.type("xml").send(cache.xml);
      return;
    }

    const urls = await buildAllUrls(ORIGIN);
    const xml = urlsToXml(urls);

    cache.xml = xml;
    cache.lastBuiltXml = now;
    cache.dirty = false;

    res.setHeader(
      "Cache-Control",
      "public, max-age=300, s-maxage=1200, stale-while-revalidate=3600"
    );
    res.type("xml").send(xml);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /news-sitemap.xml
 */
router.get("/news-sitemap.xml", async (req, res, next) => {
  try {
    const now = Date.now();
    const maxAgeMs = 5 * 60 * 1000; // 5 min

    if (
      !cache.dirty &&
      cache.news &&
      now - cache.lastBuiltNews < maxAgeMs
    ) {
      res.setHeader(
        "Cache-Control",
        "public, max-age=300, s-maxage=1200, stale-while-revalidate=3600"
      );
      res.type("xml").send(cache.news);
      return;
    }

    const xml = await buildNewsXml(ORIGIN);

    cache.news = xml;
    cache.lastBuiltNews = now;
    cache.dirty = false;

    res.setHeader(
      "Cache-Control",
      "public, max-age=300, s-maxage=1200, stale-while-revalidate=3600"
    );
    res.type("xml").send(xml);
  } catch (e) {
    next(e);
  }
});

module.exports = {
  router,
  markSitemapDirty,
  setModels, // exported so index.js can inject Article/Category/Tag
};
