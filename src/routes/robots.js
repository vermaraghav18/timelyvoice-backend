// backend/src/routes/robots.js
const express = require('express');
const router = express.Router();

/**
 * ---------------------------------------------------------------------
 * robots.txt handler
 * ---------------------------------------------------------------------
 * - In production, always advertises the canonical site origin
 *   (https://timelyvoice.com or process.env.SITE_URL)
 * - In dev, auto-detects the current host so you can test locally.
 * - Blocks crawl of admin + API/analytics while keeping all public
 *   pages crawlable.
 * ---------------------------------------------------------------------
 */

const PROD_SITE =
  (process.env.SITE_URL && process.env.SITE_URL.replace(/\/+$/, '')) ||
  'https://timelyvoice.com';

/** Resolve the site origin for this request */
function getSiteOrigin(req) {
  // Force canonical origin in production
  if (process.env.NODE_ENV === 'production') {
    return PROD_SITE;
  }

  // In dev, infer from request headers (localhost, etc.)
  const proto =
    req.headers['x-forwarded-proto'] ||
    req.protocol ||
    'http';
  const host =
    req.headers['x-forwarded-host'] ||
    req.headers.host ||
    'localhost:5173';

  // Always normalize to https:// for consistency
  return `${proto}://${host}`.replace(/^http:\/\//, 'https://').replace(/\/+$/, '');
}

router.get('/robots.txt', (req, res) => {
  const SITE_ORIGIN = getSiteOrigin(req);

  const body = [
    'User-agent: *',
    // Block non-public surfaces
    'Disallow: /admin',
    'Disallow: /api/',
    'Disallow: /analytics/',
    'Disallow: /newsletter/',
    'Disallow: /comments/',
    'Disallow: /rss',
    '',
    // Everything else is fine to crawl
    'Allow: /',
    '',
    // Sitemaps
    `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
    `Sitemap: ${SITE_ORIGIN}/news-sitemap.xml`,
    '',
  ].join('\n');

  res.type('text/plain').send(body);
});

module.exports = router;
