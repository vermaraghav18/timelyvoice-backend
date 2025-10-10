// backend/src/routes/rss.js
const express = require('express');
const router = express.Router();

// If your project already centralizes models, adjust this import path:
const Article = require('../models/Article'); // <-- confirm path

const SITE_URL = process.env.SITE_URL?.replace(/\/+$/, '') || 'https://yourdomain.com';
const PUB_NAME = process.env.PUBLICATION_NAME || 'Your Publication';
const LANGUAGE = process.env.PUBLICATION_LANG || 'en';

function esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function cdata(text = '') {
  // Wrap in CDATA, but avoid ending the CDATA accidentally
  return `<![CDATA[${String(text).replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

function getImageUrl(a) {
  // Try the common places we’ve seen in your content
  const raw =
    a.coverImage?.url ||
    a.heroImage?.url ||
    a.featuredImage?.url ||
    a.image?.url ||
    a.ogImage?.url ||
    a.thumbnail?.url ||
    a.seo?.image?.url ||
    a.coverImage ||
    a.heroImage ||
    a.featuredImage ||
    a.image ||
    a.ogImage ||
    a.thumbnail ||
    a.seo?.image ||
    (Array.isArray(a.images) && (a.images[0]?.url || a.images[0]));

  if (!raw) return null;
  const val = String(raw);
  if (val.startsWith('http')) return val;
  return `${SITE_URL}${val.startsWith('/') ? '' : '/'}${val}`;
}

router.get('/rss.xml', async (req, res) => {
  try {
    // Optional controls: ?limit=, ?page=
    const limit = Number(req.query.limit) || 0;    // 0 = no limit (all)
    const page = Math.max(1, Number(req.query.page) || 1);

    const query = {
      status: 'published',
      publishAt: { $lte: new Date() },
    };

    // Select only what we need; adjust fields to your schema
    const projection = {
      _id: 0,
      slug: 1,
      title: 1,
      summary: 1,
      excerpt: 1,
      description: 1,
      coverImage: 1,
      heroImage: 1,
      image: 1,
      images: 1,
      updatedAt: 1,
      publishAt: 1,
      createdAt: 1,
    };

    const cursor = Article.find(query, projection)
      .sort({ publishAt: -1 })
      .skip(limit ? (page - 1) * limit : 0)
      .limit(limit || 0)
      .lean();

    const articles = await cursor.exec();

    // Build channel metadata
    const now = new Date();
    const lastBuildDate =
      articles.length > 0
        ? new Date(articles[0].updatedAt || articles[0].publishAt || now)
        : now;

    // Build channel
    let xml = '';
    xml += `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">\n`;
    xml += `<channel>\n`;
    xml += `  <title>${esc(PUB_NAME)}</title>\n`;
    xml += `  <link>${SITE_URL}/</link>\n`;
    xml += `  <description>${esc(PUB_NAME)} — Full site feed</description>\n`;
    xml += `  <language>${esc(LANGUAGE)}</language>\n`;
    xml += `  <lastBuildDate>${lastBuildDate.toUTCString()}</lastBuildDate>\n`;
    xml += `  <generator>Custom RSS (Express)</generator>\n`;

    for (const a of articles) {
      const link = `${SITE_URL}/article/${a.slug}`;
      const title = a.title || a.slug || 'Untitled';
      const pubDate = new Date(a.publishAt || a.createdAt || a.updatedAt || now);
      const updDate = new Date(a.updatedAt || a.publishAt || now);
      const summary = a.summary || a.excerpt || a.description || '';
      const imageUrl = getImageUrl(a);

      xml += `  <item>\n`;
      xml += `    <title>${esc(title)}</title>\n`;
      xml += `    <link>${link}</link>\n`;
      xml += `    <guid isPermaLink="true">${link}</guid>\n`;
      xml += `    <pubDate>${pubDate.toUTCString()}</pubDate>\n`;
      // Not standard RSS but widely used—many readers show this:
      xml += `    <dc:date xmlns:dc="http://purl.org/dc/elements/1.1/">${updDate.toISOString()}</dc:date>\n`;

      // Prefer CDATA so you can include HTML in summary safely if needed
      if (summary) {
        xml += `    <description>${cdata(summary)}</description>\n`;
      } else {
        xml += `    <description>${cdata(title)}</description>\n`;
      }

      if (imageUrl) {
        // 1) enclosure is RSS-native
        xml += `    <enclosure url="${esc(imageUrl)}" type="image/jpeg" />\n`;
        // 2) media:content improves compatibility with modern readers
        xml += `    <media:content url="${esc(imageUrl)}" medium="image" />\n`;
      }

      xml += `  </item>\n`;
    }

    xml += `</channel>\n`;
    xml += `</rss>\n`;

    res.set('Content-Type', 'application/rss+xml; charset=utf-8');
    // Cache for 5 minutes; tweak as you like
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=300');
    return res.send(xml);
  } catch (err) {
    console.error('RSS generation error:', err);
    return res.status(500).send('RSS feed error');
  }
});

module.exports = router;
