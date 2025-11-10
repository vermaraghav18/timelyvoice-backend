// backend/canonical.js
const fs = require('fs');
const path = require('path');

function findIndexHtml() {
  const candidates = [
    process.env.FRONTEND_INDEX_PATH,                                  // explicit override
    path.join(__dirname, '../frontend/dist/index.html'),              // repo layout
    path.join(process.cwd(), 'frontend/dist/index.html'),
    path.join(process.cwd(), 'dist/index.html'),
    path.join(__dirname, '../public/index.html'),                     // any fallback you might ship
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch (_) { /* try next */ }
  }
  return null;
}

const FALLBACK_HTML = `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>The Timely Voice</title>
</head>
<body>
  <div id="root"></div>
  <!-- No built SPA found; serving minimal shell so backend can run -->
</body></html>`;

let TEMPLATE = null;

function normalizePath(p) {
  const clean = (p || '/').toLowerCase();
  if (clean === '/') return '/';
  return clean.endsWith('/') ? clean.slice(0, -1) : clean;
}

module.exports = function canonicalMiddleware(req, res, next) {
  const p = req.path || '';

  // let API/assets/feeds/SSR pass through
  if (
    p.startsWith('/api') ||
    p.startsWith('/assets') ||
    p === '/robots.txt' ||
    p.startsWith('/sitemap') ||
    p === '/rss.xml' ||
    p.startsWith('/rss/') ||
    p.startsWith('/ssr/')
  ) return next();

  // lazy-load template once
  if (TEMPLATE == null) {
    TEMPLATE = findIndexHtml() || FALLBACK_HTML;
    if (TEMPLATE === FALLBACK_HTML) {
      console.warn('[canonical] index.html not found; using fallback shell. (Set FRONTEND_INDEX_PATH or build/copy dist)');
    }
  }

  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host  = req.headers['x-forwarded-host']  || req.get('host');
  const canon = `${proto}://${host}${normalizePath(req.path)}`;

  const html = TEMPLATE.replace('</head>', `  <link rel="canonical" href="${canon}">\n</head>`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
};
