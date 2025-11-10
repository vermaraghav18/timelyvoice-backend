// backend/canonical.js
const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '../frontend/dist/index.html');
const TEMPLATE = fs.readFileSync(INDEX_PATH, 'utf8');

function normalizePath(p) {
  const clean = (p || '/').toLowerCase();
  if (clean === '/') return '/';
  return clean.endsWith('/') ? clean.slice(0, -1) : clean;
}

module.exports = function canonicalMiddleware(req, res, next) {
  const p = req.path || '';

  // ✅ Let APIs, assets and special files pass
  if (
    p.startsWith('/api') ||
    p.startsWith('/assets') ||
    p === '/robots.txt' ||
    p.startsWith('/sitemap') ||
    p === '/rss.xml' ||
    p.startsWith('/rss/') ||
    p.startsWith('/ssr/')    // your crawler HTML
  ) return next();

  // Serve SPA HTML with per-request canonical
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host  = req.headers['x-forwarded-host']  || req.get('host');
  const canon = `${proto}://${host}${normalizePath(req.path)}`;

  const html = TEMPLATE.replace('</head>',
    `  <link rel="canonical" href="${canon}">\n</head>`);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
};
