// backend/url-normalize.js
module.exports = function urlNormalize(req, res, next) {
  const p = req.path;

  // skip API, assets, SSR, RSS, sitemap, robots
  if (
    p.startsWith('/api') ||
    p.startsWith('/assets') ||
    p.startsWith('/ssr') ||
    p.startsWith('/rss') ||
    p.startsWith('/sitemap') ||
    p === '/robots.txt'
  ) return next();

  const original = req.originalUrl; // path + query
  const [pathOnly, query = ''] = original.split('?');

  // 1) lowercase the path
  let target = pathOnly.toLowerCase();

  // 2) remove trailing slash (except root)
  if (target !== '/' && target.endsWith('/')) target = target.slice(0, -1);

  // 3) drop tracking params
  const params = new URLSearchParams(query);
  const drop = ['utm_', 'gclid', 'fbclid'];
  for (const k of [...params.keys()]) {
    if (drop.some(p => k.toLowerCase().startsWith(p))) params.delete(k);
  }
  const kept = params.toString();
  const normalized = target + (kept ? `?${kept}` : '');

  if (normalized !== original) {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return res.redirect(301, `${proto}://${host}${normalized}`);
  }
  next();
};
