// backend/src/middleware/canonicalHost.js
/**
 * Canonical Host Middleware (safe for bots & feeds)
 * - Force HTTPS + apex host ONLY for real HTML pageviews
 * - Never touch XML/TXT/RSS/API/uploads/static etc.
 * - Never redirect localhost/dev
 */
module.exports = function canonicalHost() {
  const FRONTEND_BASE_URL =
    process.env.FRONTEND_BASE_URL ||
    process.env.SITE_URL ||
    'https://timelyvoice.com';

  const APEX = FRONTEND_BASE_URL.replace(/\/+$/, '');
  const APEX_HOST = APEX.replace(/^https?:\/\//, ''); // e.g. timelyvoice.com
  const IS_PROD = (process.env.NODE_ENV || '').toLowerCase() === 'production';

  // Prefixes we never redirect (non-HTML or backend-y)
  const SKIP_PREFIXES = [
    '/api/',
    '/analytics',
    '/ssr',
    '/favicon',
    '/logo',
    '/manifest',
    '/static',
    '/assets',
    '/uploads',
  ];

  // Exact files to skip
  const SKIP_EXACT = new Set([
    '/sitemap.xml',
    '/news-sitemap.xml',
    '/robots.txt',
    '/rss.xml',
  ]);

  // Extensions to skip
  const SKIP_EXT_RE = /\.(xml|txt|json|webmanifest)$/i;

  return function canonicalHostMiddleware(req, res, next) {
    const hostHeader = (req.headers.host || '').toLowerCase();
    const originalUrl = req.originalUrl || req.url || '/';
    const pathOnly = (req.path || originalUrl.split('?')[0]) || '/';
    const accept = String(req.headers.accept || '');

    // 1) Never enforce in dev/localhost
    if (
      !IS_PROD ||
      hostHeader.startsWith('localhost') ||
      hostHeader.startsWith('127.0.0.1') ||
      hostHeader.startsWith('::1')
    ) {
      return next();
    }

    // 2) Skip backend/non-HTML resources
    if (
      SKIP_PREFIXES.some((p) => pathOnly.startsWith(p)) ||
      SKIP_EXACT.has(pathOnly) ||
      SKIP_EXT_RE.test(pathOnly)
    ) {
      return next();
    }

    // 3) Only consider canonical redirects for real HTML navigations
    const wantsHtml = req.method === 'GET' && accept.includes('text/html');
    if (!wantsHtml) return next();

    // 4) Enforce HTTPS + apex host; avoid redirecting to the same thing
    const isHttps =
      req.secure || req.headers['x-forwarded-proto'] === 'https';
    const isWWW = hostHeader.startsWith('www.');
    const cleanHost = isWWW ? hostHeader.slice(4) : hostHeader;

    const needsHttps = !isHttps;
    const needsApex = cleanHost !== APEX_HOST;

    if (needsHttps || needsApex) {
      const dest = `https://${APEX_HOST}${originalUrl}`;
      // If we're already at the final dest, don't loop
      if (hostHeader === APEX_HOST && isHttps) return next();
      return res.redirect(308, dest); // 308 keeps method/body; fine for HTML GET
    }

    // 5) Good to go
    return next();
  };
};
