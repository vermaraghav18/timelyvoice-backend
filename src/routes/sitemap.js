// backend/src/routes/sitemap.js
const express = require("express");
const dayjs = require("dayjs");

/* -------------------------------------------
   Model injection (✅ NEW)
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
const ORIGIN = (process.env.FRONTEND_BASE_URL ||
  process.env.SITE_URL ||
  "http://localhost:5173")
  .replace(/\/+$/, "")
  .replace(/^http:\/\//, "https://");

const PUBLICATION_NAME = process.env.PUBLICATION_NAME || "My News";
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
   Build main sitemap data (uses injected Models ✅)
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

  // Articles (only published + visible by schedule)
  const now = new Date();

  // ✅ Visibility rules:
  // - status = published
  // - publishedAt <= now OR missing/null
  // - AND publishAt <= now OR missing/null
  const articles = await Models.Article.find(
    {
      status: "published",
      $and: [
        {
          $or: [
            { publishedAt: { $lte: now } },
            { publishedAt: { $exists: false } },
            { publishedAt: null },
          ],
        },
        {
          $or: [
            { publishAt: { $lte: now } },
            { publishAt: { $exists: false } },
            { publishAt: null },
          ],
        },
      ],
    },
    { slug: 1, updatedAt: 1, publishAt: 1, publishedAt: 1, title: 1 }
  )
    .sort({ publishedAt: -1, updatedAt: -1, _id: -1 })
    .lean();

  // Core urls (homepage + key static pages)
  const core = [
    // Home (SPA is fine to include; discovery is handled by /news)
    { loc: origin, changefreq: "hourly", priority: "1.0" },

    // ✅ Crawl/discovery hub (STATIC HTML on Vercel)
    { loc: `${origin}/news`, changefreq: "hourly", priority: "0.95" },

    // Key sections
    { loc: `${origin}/top-news`, changefreq: "hourly", priority: "0.9" },

    // Trust / policy pages (important for Google Ads & E-E-A-T)
    { loc: `${origin}/about`, changefreq: "yearly", priority: "0.4" },
    { loc: `${origin}/contact`, changefreq: "yearly", priority: "0.4" },
    { loc: `${origin}/editorial-policy`, changefreq: "yearly", priority: "0.3" },
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
  // ❌ We intentionally keep tag listing pages OUT of the main sitemap
  //    to avoid thin/duplicate index candidates.
  const tagUrls = []; // intentionally empty

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
  return [...core, ...catUrls, ...tagUrls, ...articleUrls];
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

  // ✅ Correct logic:
  // AND(
  //   OR(publishAt <= now OR missing/null),
  //   OR(publishedAt >= twoDaysAgo OR (missing publishedAt AND createdAt >= twoDaysAgo))
  // )
  const articles = await Models.Article.find(
    {
      status: "published",
      $and: [
        {
          $or: [
            { publishAt: { $lte: now } },
            { publishAt: { $exists: false } },
            { publishAt: null },
          ],
        },
        {
          $or: [
            { publishedAt: { $gte: twoDaysAgo } },
            {
              $and: [
                { publishedAt: { $exists: false } },
                { createdAt: { $gte: twoDaysAgo } },
              ],
            },
          ],
        },
      ],
    },
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

    if (!cache.dirty && cache.xml && now - cache.lastBuiltXml < maxAgeMs) {
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

    if (!cache.dirty && cache.news && now - cache.lastBuiltNews < maxAgeMs) {
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
  setModels, // ✅ exported so index.js can inject Article/Category/Tag
};
