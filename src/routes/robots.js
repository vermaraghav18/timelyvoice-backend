// src/routes/robots.js
const express = require("express");
const router = express.Router();

router.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(`
User-agent: *
Allow: /

Disallow: /admin
Disallow: /api/

Sitemap: ${process.env.SITE_URL || "http://localhost:5173"}/sitemap.xml
Sitemap: ${process.env.SITE_URL || "http://localhost:5173"}/news-sitemap.xml
  `.trim());
});

module.exports = router;
