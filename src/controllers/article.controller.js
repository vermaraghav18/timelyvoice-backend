// backend/src/controllers/article.controller.js
const Article = require('../models/Article');
const Category = require('../models/Category');
const slugify = require('slugify');
const { finalizeArticleImages } = require('../services/finalizeArticleImages');
const { extractTags } = require('../services/textFeatures');

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
    q.status = (req.query.status || 'published').toLowerCase();

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

    // Show only already-published items when status=published
    if (String(q.status).toLowerCase() === 'published') {
      q.publishedAt = { $lte: new Date() };
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

/**
 * GET /api/articles/slug/:slug
 * - Returns the article by slug if it exists and is published.
 * - If the requested slug is the "base" slug but the stored one is uniquified
 *   (e.g., "-2"), respond 308 with { redirectTo } so the frontend replaces the URL.
 */
exports.getBySlug = async (req, res) => {
  try {
    const raw = String(req.params.slug || '').trim();
    if (!raw) return res.status(400).json({ error: 'bad_slug' });

    // Only show published & already-live (publishedAt <= now)
    const publishedFilter = { status: 'published', publishedAt: { $lte: new Date() } };

    // 1) Exact match
    let doc = await Article.findOne({ slug: raw, ...publishedFilter }).lean();
    if (doc) return res.json(doc);

    // 2) Fallback: match base OR base-<number>
    const rx = new RegExp(`^${escRegex(raw)}(?:-\\d+)?$`, 'i');
    doc = await Article
      .findOne({ slug: rx, ...publishedFilter })
      .sort({ publishedAt: -1, createdAt: -1 })
      .lean();

    if (doc) {
      // Tell client the canonical slug. Your Article.jsx already handles 308 + redirectTo
      return res.status(308).json({ redirectTo: `/article/${doc.slug}` });
    }

    return res.status(404).json({ error: 'not_found' });
  } catch (e) {
    console.error('GET /api/articles/slug/* error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
};

exports.create = async (req, res) => {
  try {
    const payload = normalizeEmptyImages({ ...req.body });

    // Prepare slug early if not present
    payload.slug =
      payload.slug ||
      slugify(payload.title || 'article', { lower: true, strict: true }) ||
      `article-${Date.now()}`;

    // Normalize status + set publishedAt if coming in as Published
    payload.status = (payload.status || 'draft').toLowerCase();
    if (payload.status === 'published' && !payload.publishedAt) {
      payload.publishedAt = new Date();
    }

    // Auto-generate tags only if none were provided
    if (!payload.tags || (Array.isArray(payload.tags) && payload.tags.length === 0)) {
      try {
        payload.tags = extractTags(
          {
            title: payload.title || '',
            summary: payload.summary || '',
            body: payload.body || '',
          },
          8
        );
      } catch (_) {
        payload.tags = payload.tags || [];
      }
    }

    // Respect manual image URL on create (when no publicId provided)
    const manualUrlProvidedOnCreate =
      typeof payload.imageUrl === 'string' &&
      payload.imageUrl.trim() !== '' &&
      !payload.imagePublicId;

    // If any image fields missing → finalize.
    // Do NOT overwrite a manual imageUrl; only backfill missing fields.
    if (!payload.imageUrl || !payload.imagePublicId || !payload.ogImage || !payload.thumbImage) {
      const beforeManualUrl = manualUrlProvidedOnCreate ? payload.imageUrl : (payload.imageUrl || null);

      const fin = await finalizeArticleImages(payload);

      payload.imageUrl = beforeManualUrl || fin.imageUrl;

      if (!payload.imagePublicId) {
        payload.imagePublicId = fin.imagePublicId || null;
      }

      if (!payload.ogImage) payload.ogImage = fin.ogImage || null;
      if (!payload.thumbImage) payload.thumbImage = fin.thumbImage || null;

      payload.imageAlt = payload.imageAlt || fin.imageAlt || '';
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
 * Also ensures publishing sets a publishedAt timestamp.
 */
exports.update = async (req, res) => {
  try {
    const id = req.params.id;
    const patch = normalizeEmptyImages({ ...req.body });

    const doc = await Article.findById(id);
    if (!doc) return res.status(404).json({ ok: false, error: 'Not found' });

    Object.assign(doc, patch);

    if (!doc.slug) {
      doc.slug =
        slugify(doc.title || 'article', { lower: true, strict: true }) ||
        `article-${Date.now()}`;
    }

    // 1) Normalize status casing (store as lowercase)
    if (typeof doc.status === 'string') {
      doc.status = doc.status.toLowerCase();
    }

    // 2) If transitioning to published and no publishedAt yet, set it now
    if (doc.status === 'published' && !doc.publishedAt) {
      doc.publishedAt = new Date();
    }

    // 3) Manual image override handling:
    // If the patch included a new imageUrl and NO imagePublicId, prefer the URL and clear publicId.
    const manualUrlProvided =
      Object.prototype.hasOwnProperty.call(patch, 'imageUrl') &&
      typeof patch.imageUrl === 'string' &&
      patch.imageUrl?.trim() !== '' &&
      !patch.imagePublicId;

    if (manualUrlProvided) {
      // ensure we use the manual URL
      doc.imagePublicId = null; // so downstream won't re-override URL with a Cloudinary public id
    }

    // If tags were cleared/missing after patch, auto-generate tags again
    if (!doc.tags || (Array.isArray(doc.tags) && doc.tags.length === 0)) {
      try {
        doc.tags = extractTags(
          {
            title: doc.title || '',
            summary: doc.summary || '',
            body: doc.body || '',
          },
          8
        );
      } catch (_) {
        doc.tags = doc.tags || [];
      }
    }

    // Finalize ONLY missing fields; do not overwrite manual URL
    if (!doc.imageUrl || !doc.imagePublicId || !doc.ogImage || !doc.thumbImage) {
      const beforeManualUrl = doc.imageUrl || null;

      const fin = await finalizeArticleImages(doc.toObject());

      // If the editor provided a manual Image URL, DO NOT overwrite it.
      doc.imageUrl = beforeManualUrl || fin.imageUrl;

      // Only set publicId if we don't already have one
      if (!doc.imagePublicId) {
        doc.imagePublicId = fin.imagePublicId || null;
      }

      // Always backfill OG & thumb if missing
      if (!doc.ogImage) doc.ogImage = fin.ogImage || null;
      if (!doc.thumbImage) doc.thumbImage = fin.thumbImage || null;

      doc.imageAlt = doc.imageAlt || fin.imageAlt || '';
    }

    await doc.save();
    res.json({ ok: true });
  } catch (e) {
    console.error('PATCH /api/articles/:id update error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
