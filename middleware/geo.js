// backend/middleware/geo.js
const geoip = require('geoip-lite');

/**
 * GEO middleware:
 * 1) Prefer edge/CDN headers (Cloudflare / Vercel / Fastly).
 * 2) Fallback to geoip-lite using the client IP.
 * 3) Always set req.geo.country (2-letter) or 'ZZ' if unknown.
 *
 * Notes:
 * - Admin preview header X-Geo-Preview-Country is guarded in index.js already.
 * - app.set('trust proxy', 1) should be enabled when behind a proxy/CDN,
 *   so req.ip / X-Forwarded-For provide the client IP.
 */
module.exports = function geoMiddleware() {
  return function (req, res, next) {
    try {
      // If something upstream already set geo, keep it
      if (req.geo && (req.geo.country || req.geo.city)) return next();

      const hdr = (n) => req.headers[n.toLowerCase()];

      // 1) Prefer trusted country/region/city headers from edge providers
      // (Admin preview header is validated in index.js before we get here)
      let country =
        hdr('x-geo-preview-country') ||     // (admin preview — guarded elsewhere)
        hdr('cf-ipcountry') ||              // Cloudflare
        hdr('x-vercel-ip-country') ||       // Vercel
        hdr('x-fastly-country-code') ||     // Fastly
        hdr('x-country') ||                 // generic/custom
        null;

      let region =
        hdr('x-vercel-ip-country-region') ||
        hdr('cf-region-code') ||
        hdr('x-region') ||
        null;

      let city =
        hdr('x-vercel-ip-city') ||
        hdr('cf-ipcity') ||
        hdr('x-city') ||
        null;

      // Normalize header country to 2-letter code
      if (typeof country === 'string') country = country.toUpperCase().slice(0, 2);

      // Resolve client IP (trust proxy when enabled in index.js)
      // Prefer X-Forwarded-For's first IP; fallback to socket addresses
      const forwardedFor = (hdr('x-forwarded-for') || '').split(',')[0].trim();
      const ip =
        forwardedFor ||
        req.ip ||
        req.socket?.remoteAddress ||
        req.connection?.remoteAddress ||
        (req.connection && req.connection.socket && req.connection.socket.remoteAddress) ||
        '';

      // 2) Fallback to geoip-lite if country still missing
      let source = country ? 'header' : undefined;
      if (!country && ip) {
        const lookup = geoip.lookup(ip);
        if (lookup) {
          country = (lookup.country || 'ZZ').toUpperCase();
          // lookup.region is typically a code; keep as-is if present
          region = region || (lookup.region ? String(lookup.region) : null);
          city = city || (lookup.city ? String(lookup.city) : null);
          source = 'geoip-lite';
        }
      }

      // 3) Normalize unknowns
      if (!country) {
        country = 'ZZ';
        source = source || 'unknown';
      }

      req.geo = {
        ip: ip || null,
        country,
        region: region ? String(region).toUpperCase() : null,
        city: city || null,
        source
      };

      // Helpful response headers for downstream caches/debugging
      res.setHeader('X-Geo-Country', country);
      res.append(
        'Vary',
        'CF-IPCountry, X-Vercel-IP-Country, X-Vercel-IP-Country-Region, X-Vercel-IP-City, X-Fastly-Country-Code, X-Geo-Preview-Country'
      );

      return next();
    } catch (e) {
      // On any error, default to unknown
      req.geo = { country: 'ZZ', source: 'error' };
      res.setHeader('X-Geo-Country', 'ZZ');
      res.append(
        'Vary',
        'CF-IPCountry, X-Vercel-IP-Country, X-Vercel-IP-Country-Region, X-Vercel-IP-City, X-Fastly-Country-Code, X-Geo-Preview-Country'
      );
      return next();
    }
  };
};
