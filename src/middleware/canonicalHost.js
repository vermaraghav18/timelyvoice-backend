// backend/src/middleware/canonicalHost.js
/**
 * ---------------------------------------------------------------------
 * Canonical Host Middleware
 * ---------------------------------------------------------------------
 * Enforces:
 *   - HTTPS
 *   - Apex (no www)
 *   - Skips APIs, assets, and backend routes
 *   - Never redirects localhost/dev
 * ---------------------------------------------------------------------
 */

module.exports = function canonicalHost() {
  // Normalize apex URL (no trailing slash)
  const FRONTEND_BASE_URL =
    process.env.FRONTEND_BASE_URL ||
    process.env.SITE_URL ||
    'https://timelyvoice.com';

  const APEX = FRONTEND_BASE_URL.replace(/\/+$/, '');
  const APEX_HOST = APEX.replace(/^https?:\/\//, ''); // e.g. timelyvoice.com
  const IS_PROD = (process.env.NODE_ENV || '').toLowerCase() === 'production';

  // Paths to skip redirection entirely (non-HTML or API)
  const SKIP_PATH_PREFIXES = [
    '/api/',
    '/analytics',
    '/rss',
    '/ssr',
    '/favicon',
    '/logo',
    '/robots',
    '/sitemap',
    '/manifest',
    '/static',
    '/assets',
    '/uploads',
  ];

  return function canonicalHostMiddleware(req, res, next) {
    const hostHeader = (req.headers.host || '').toLowerCase();
    const originalUrl = req.originalUrl || req.url || '/';

    // 1️⃣ Skip in development or localhost
    if (
      !IS_PROD ||
      hostHeader.startsWith('localhost') ||
      hostHeader.startsWith('127.0.0.1') ||
      hostHeader.startsWith('::1')
    ) {
      return next();
    }

    // 2️⃣ Skip backend or non-HTML paths
    if (SKIP_PATH_PREFIXES.some((prefix) => originalUrl.startsWith(prefix))) {
      return next();
    }

    // 3️⃣ Determine if redirect is needed
    const isHttps =
      req.secure || req.headers['x-forwarded-proto'] === 'https';

    const isWWW = hostHeader.startsWith('www.');
    const cleanHost = isWWW ? hostHeader.slice(4) : hostHeader;

    const needsHttps = !isHttps;
    const needsApex = cleanHost !== APEX_HOST;

    // 4️⃣ Redirect if either HTTPS or host mismatch
    if (needsHttps || needsApex) {
      const redirectUrl = `https://${APEX_HOST}${originalUrl}`;
      return res.redirect(301, redirectUrl);
    }

    // ✅ Otherwise proceed
    next();
  };
};
