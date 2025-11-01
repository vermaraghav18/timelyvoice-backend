// backend/src/controllers/article.controller.js
const Article = require('../models/Article');
const Category = require('../models/Category');
const slugify = require('slugify');
const { finalizeArticleImages } = require('../services/finalizeArticleImages');
const { extractTags } = require('../services/textFeatures'); // <-- ADD THIS

function escRegex(str = '') {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeEmptyImages(obj = {}) {
  const o = obj;
  if (o.imageUrl === '') o.imageUrl = null;
  if (o.imagePublicId === '') o.imagePublicId = null;
  if (o.ogImage === '') o.ogImage = null;
  if (o.thumbImage === '') o.thumbImage = null;
  if (o.seo?.ogImageUrl === '') o.seo.ogImageUrl = null;
  return o;
}

/**
 * GET /api/articles
 * Query params:
 *   q        - search text (safe regex on title/summary/slug)
 *   status   - defaults to 'published'
 *   category - slug or name; stored as Category.name in Article
 *   tag      - exact tag match
 *   page     - 1-based page number
 *   limit    - requested page size (hard-capped)
 */
exports.list = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitReq = Math.max(parseInt(req.query.limit || '0', 10), 0);
    const limit = Math.min(limitReq || 12, 24);

    const q = {};
    q.status = req.query.status || 'published';

    if (req.query.category) {
      const raw = String(req.query.category);
      const catDoc = await Category
        .findOne({ $or: [{ slug: raw }, { slug: slugify(raw) }, { name: raw }] })
        .select('name')
        .lean();
      q.category = catDoc ? catDoc.name : raw;
    }

    if (req.query.tag) q.tags = req.query.tag;

    if (req.query.q && String(req.query.q).trim()) {
      const rx = new RegExp(escRegex(String(req.query.q).trim()), 'i');
      q.$or = [{ title: rx }, { summary: rx }, { slug: rx }];
    }

    const PROJECTION = {
      body: 0,
      bodyHtml: 0,
    };

    const SORT = { publishedAt: -1, _id: -1 };

    const cursor = Article
      .find(q, PROJECTION)
      .sort(SORT)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean({ getters: true })
      .maxTimeMS(5000);

    const [items, total] = await Promise.all([
      cursor.exec(),
      Article.countDocuments(q),
    ]);

    res.json({ page, pageSize: items.length, total, items });
  } catch (err) {
    console.error('GET /api/articles list error:', err);
    res.status(500).json({ error: 'Failed to list/search articles' });
  }
};

/**
 * POST /api/articles
 * Creates an article and guarantees image fields via finalizeArticleImages.
 */
exports.create = async (req, res) => {
  try {
    const payload = normalizeEmptyImages({ ...req.body });

    // Prepare slug early if not present
    payload.slug = payload.slug || slugify(payload.title || 'article', { lower: true, strict: true }) || `article-${Date.now()}`;

    // Auto-generate tags only if none were provided
if (!payload.tags || (Array.isArray(payload.tags) && payload.tags.length === 0)) {
  try {
    payload.tags = extractTags(
      {
        title: payload.title || '',
        summary: payload.summary || '',
        body: payload.body || ''
      },
      8
    );
  } catch (_) {
    payload.tags = payload.tags || [];
  }
}


    // If any image fields missing → finalize
    if (!payload.imageUrl || !payload.imagePublicId || !payload.ogImage || !payload.thumbImage) {
      const fin = await finalizeArticleImages(payload);
      payload.imagePublicId = fin.imagePublicId;
      payload.imageUrl = fin.imageUrl;
      payload.ogImage = fin.ogImage;
      payload.thumbImage = fin.thumbImage;
      payload.imageAlt = payload.imageAlt || fin.imageAlt;
    }

    const doc = await Article.create(payload);
    res.status(201).json({ ok: true, id: String(doc._id), slug: doc.slug });
  } catch (e) {
    console.error('POST /api/articles create error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};

/**
 * PATCH /api/articles/:id
 * Updates an article and re-finalizes image fields if any are missing.
 */
exports.update = async (req, res) => {
  try {
    const id = req.params.id;
    const patch = normalizeEmptyImages({ ...req.body });

    const doc = await Article.findById(id);
    if (!doc) return res.status(404).json({ ok: false, error: 'Not found' });

    Object.assign(doc, patch);

    if (!doc.slug) {
      doc.slug = slugify(doc.title || 'article', { lower: true, strict: true }) || `article-${Date.now()}`;
    }

    // If tags were cleared/missing after patch, auto-generate tags again
if (!doc.tags || (Array.isArray(doc.tags) && doc.tags.length === 0)) {
  try {
    doc.tags = extractTags(
      {
        title: doc.title || '',
        summary: doc.summary || '',
        body: doc.body || ''
      },
      8
    );
  } catch (_) {
    doc.tags = doc.tags || [];
  }
}

    if (!doc.imageUrl || !doc.imagePublicId || !doc.ogImage || !doc.thumbImage) {
      const fin = await finalizeArticleImages(doc.toObject());
      doc.imagePublicId = fin.imagePublicId;
      doc.imageUrl = fin.imageUrl;
      doc.ogImage = fin.ogImage;
      doc.thumbImage = fin.thumbImage;
      doc.imageAlt = doc.imageAlt || fin.imageAlt;
    }

    await doc.save();
    res.json({ ok: true });
  } catch (e) {
    console.error('PATCH /api/articles/:id update error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
