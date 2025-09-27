// backend/middleware/geo.js
module.exports = function geoMiddleware() {
  return function (req, res, next) {
    const hdr = (n) => req.headers[n.toLowerCase()];

    // Allow an admin preview override (we'll guard this in step 3 when auth is available)
    let country =
      hdr('x-geo-preview-country') ||      // admin preview (optional)
      hdr('cf-ipcountry') ||               // Cloudflare
      hdr('x-vercel-ip-country') ||        // Vercel
      hdr('x-fastly-country-code') ||      // Fastly
      null;

    const region =
      hdr('x-vercel-ip-country-region') ||
      hdr('cf-region-code') ||
      null;

    const city =
      hdr('x-vercel-ip-city') ||
      hdr('cf-ipcity') ||
      null;

    // Normalize
    if (typeof country === 'string') country = country.toUpperCase().slice(0, 2);

    req.geo = {
      country: country || null,
      region: region ? String(region).toUpperCase() : null,
      city: city ? String(city) : null,
      source: country ? 'header' : 'unknown'
    };

    // Help caches avoid cross-geo leaks
    if (country) res.setHeader('X-Geo-Country', country);
    res.append('Vary', 'CF-IPCountry, X-Vercel-IP-Country, X-Geo-Preview-Country');

    next();
  };
};
