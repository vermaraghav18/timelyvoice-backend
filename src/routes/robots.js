// backend/src/routes/robots.js
const express = require('express');
const router = express.Router();

/**
 * ---------------------------------------------------------------------
 * Robots.txt handler
 * ---------------------------------------------------------------------
 * Ensures:
 *   - Production: always uses apex (https://timelyvoice.com)
 *   - Dev: auto-detects localhost origin (so you can test locally)
 * ---------------------------------------------------------------------
 */

const PROD_SITE = 'https://timelyvoice.com';

// Determine which origin to use
let SITE_ORIGIN;

if (process.env.NODE_ENV === 'production') {
  // Always force apex domain in production
  SITE_ORIGIN = PROD_SITE;
} else {
  // Use local frontend base if defined, else fallback
  SITE_ORIGIN = (
    process.env.FRONTEND_BASE_URL ||
    process.env.SITE_URL ||
    'http://localhost:5173'
  ).replace(/\/+$/, '');
  // normalize to https for Search Console consistency
  SITE_ORIGIN = SITE_ORIGIN.replace(/^http:\/\//, 'https://');
}

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
`User-agent: *
Allow: /

Sitemap: ${SITE_ORIGIN}/sitemap.xml
Sitemap: ${SITE_ORIGIN}/news-sitemap.xml
`
  );
});

module.exports = router;
