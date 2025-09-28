// TODO: analytics scaffolding// middleware/analyticsBotFilter.js

/**
 * Minimal bot/admin flagger.
 * - Sets req.isBot = true for known crawler User-Agents
 * - Sets req.isAdmin = true if an Authorization: Bearer <token> header is present
 *   (we'll do proper JWT validation later; for analytics we just want to exclude admin sessions)
 */
module.exports = function analyticsBotFilter() {
  // very small list for now; we’ll expand later
  const botUAs = [
    /googlebot/i,
    /bingbot/i,
    /applebot/i,
    /yandex/i,
    /duckduckbot/i,
    /baiduspider/i,
    /slackbot/i,
    /twitterbot/i,
    /facebookexternalhit/i,
    /semrushbot/i,
    /ahrefsbot/i,
  ];

  return function (req, _res, next) {
    const ua = String(req.headers['user-agent'] || '');
    req.isBot = botUAs.some((re) => re.test(ua));

    const auth = String(req.headers['authorization'] || '');
    req.isAdmin = auth.startsWith('Bearer '); // lightweight signal only

    next();
  };
};
