// backend/src/routes/robots.js
const express = require('express');
const router = express.Router();

/**
 * ---------------------------------------------------------------------
 * robots.txt (CANONICAL, GOOGLE-NEWS SAFE)
 * ---------------------------------------------------------------------
 * - ALWAYS advertises the production domain
 * - Never emits localhost / render / vercel URLs
 * - Required for stable Google Search + Google News ingestion
 * ---------------------------------------------------------------------
 */

// ✅ Canonical production origin ONLY
const SITE_ORIGIN = (
  process.env.SITE_URL ||
  'https://timelyvoice.com'
).replace(/\/+$/, '');

router.get('/robots.txt', (_req, res) => {
  const body = [
    'User-agent: *',

    // ❌ Block non-public surfaces
    'Disallow: /admin',
    'Disallow: /api/',
    'Disallow: /analytics/',
    'Disallow: /newsletter/',
    'Disallow: /comments/',
    'Disallow: /rss',

    '',
    // ✅ Everything else is crawlable
    'Allow: /',

    '',
    // ✅ Canonical sitemaps (PRODUCTION ONLY)
    `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
    `Sitemap: ${SITE_ORIGIN}/news-sitemap.xml`,
    '',
  ].join('\n');

  res.type('text/plain').send(body);
});

module.exports = router;
