// backend/src/routes/admin.articles.routes.js
// Admin routes for listing, previewing, editing and publishing Article drafts

const express = require('express');
const router = express.Router();

// Models
const Article = require('../models/Article');

// Image strategy + variants
const { decideAndAttach } = require('../services/imageStrategy');
const { buildImageVariants } = require('../services/imageVariants');
const cloudinary = require('cloudinary').v2;

// Controller for create/import/preview
const ctrl = require('../controllers/admin.articles.controller');

// If you have auth, wire it
// const { requireAuthAdmin } = require('../middleware/auth');

// ────────────────────────────────────────────────────────────────────────────────
// Helpers used by PATCH
const PLACEHOLDER_HOSTS = ['your-cdn.example', 'cdn.example.com', 'example.com'];

function isPlaceholderUrl(u = '') {
  try {
    const { hostname } = new URL(u);
    if (!hostname) return true;
    return (
      PLACEHOLDER_HOSTS.includes(hostname) ||
      hostname.endsWith('.example') ||
      hostname.includes('cdn.example')
    );
  } catch {
    // invalid URL -> treat as placeholder
    return true;
  }
}

function finalizeImageFields(article) {
  if (!article) return;
  const publicId = article.imagePublicId || process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID;
  if (!publicId) return;

  try {
    const variants = buildImageVariants(publicId);
    if (variants && typeof variants === 'object') {
      if (!article.imageUrl)
        article.imageUrl = variants.hero || variants.base || cloudinary.url(publicId, { secure: true });
      if (!article.ogImage)
        article.ogImage = variants.og || cloudinary.url(publicId, {
          width: 1200, height: 630, crop: 'fill', gravity: 'auto', format: 'jpg', secure: true
        });
      if (!article.thumbImage)
        article.thumbImage = variants.thumb || cloudinary.url(publicId, {
          width: 400, height: 300, crop: 'fill', gravity: 'auto', format: 'webp', secure: true
        });
    } else {
      if (!article.imageUrl)
        article.imageUrl = cloudinary.url(publicId, { secure: true });
      if (!article.ogImage)
        article.ogImage = cloudinary.url(publicId, {
          width: 1200, height: 630, crop: 'fill', gravity: 'auto', format: 'jpg', secure: true
        });
      if (!article.thumbImage)
        article.thumbImage = cloudinary.url(publicId, {
          width: 400, height: 300, crop: 'fill', gravity: 'auto', format: 'webp', secure: true
        });
    }
  } catch {
    if (!article.imageUrl)
      article.imageUrl = cloudinary.url(publicId, { secure: true });
    if (!article.ogImage)
      article.ogImage = cloudinary.url(publicId, {
        width: 1200, height: 630, crop: 'fill', gravity: 'auto', format: 'jpg', secure: true
      });
    if (!article.thumbImage)
      article.thumbImage = cloudinary.url(publicId, {
        width: 400, height: 300, crop: 'fill', gravity: 'auto', format: 'webp', secure: true
      });
  }

  if (!article.imageAlt) {
    article.imageAlt = article.title || 'News image';
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// CREATE (single) — POST /api/admin/articles
router.post('/', ctrl.createOne);

// BULK IMPORT — POST /api/admin/articles/import
router.post('/import', ctrl.importMany);

// PREVIEW BULK IMPORT (no DB writes) — POST /api/admin/articles/preview-import
router.post('/preview-import', ctrl.previewMany);

// LIST DRAFTS — GET /api/admin/articles/drafts
router.get('/drafts', async (req, res) => {
  try {
    const q = {
      $and: [
        { $or: [{ status: 'draft' }, { status: { $exists: false } }] },
        { $or: [{ publishedAt: { $exists: false } }, { publishedAt: null }] }
      ]
    };

    const drafts = await Article.find(q)
      .select('_id title category slug status summary imageUrl imagePublicId createdAt updatedAt')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    res.json(drafts);
  } catch (err) {
    console.error('[admin.articles] drafts error', err);
    res.status(500).json({ error: 'failed_to_list_drafts' });
  }
});


// DELETE — DELETE /api/admin/articles/:id
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await Article.findByIdAndDelete(id).lean();

    if (!doc) return res.status(404).json({ error: 'not_found' });

    // OPTIONAL: if you store Cloudinary publicId, also clean up asset
    // if (doc.imagePublicId) {
    //   try { await cloudinary.uploader.destroy(doc.imagePublicId); } catch (_) {}
    // }

    return res.json({ ok: true, deletedId: id });
  } catch (err) {
    console.error('[admin.articles] delete error', err);
    return res.status(500).json({ error: 'failed_to_delete_article' });
  }
});


// LIST — GET /api/admin/articles
router.get('/', async (req, res) => {
  try {
    const { status, category, q, page = 1, limit = 20 } = req.query;

    const and = [];
    if (status) and.push({ status });
    if (category) and.push({ $or: [{ 'category.slug': category }, { category }] });

    if (q) {
      const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      and.push({ $or: [{ title: rx }, { summary: rx }, { body: rx }] });
    }

    const query = and.length ? { $and: and } : {};

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const perPage = Math.max(1, Math.min(200, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * perPage;

    const [items, total] = await Promise.all([
      Article.find(query)
        .select('_id title slug status category summary publishAt updatedAt imageUrl imagePublicId ogImage thumbImage tags')
        .sort({ updatedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(perPage)
        .lean(),
      Article.countDocuments(query),
    ]);

    res.json({ items, total, page: pageNum, limit: perPage });
  } catch (err) {
    console.error('[admin.articles] list error', err);
    res.status(500).json({ error: 'failed_to_list_articles' });
  }
});


// GET ONE — GET /api/admin/articles/:id
router.get('/:id', async (req, res) => {
  try {
    const article = await Article.findById(req.params.id).lean();
    if (!article) return res.status(404).json({ error: 'not_found' });
    res.json(article);
  } catch (err) {
    console.error('[admin.articles] get error', err);
    res.status(500).json({ error: 'failed_to_get_article' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// PATCH (fix): normalize placeholders + rebuild Cloudinary URLs
// PATCH /api/admin/articles/:id
router.patch('/:id', async (req, res) => {
  try {
    const allowed = [
      'title',
      'slug',
      'category',
      'summary',
      'imageUrl',
      'imagePublicId',
      'imageAlt',
      'status',
      'tags',
      'body',
      'bodyHtml',
      'author'
    ];

    // 1) pick allowed fields
    const patch = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) patch[k] = req.body[k];
    }

    // 2) normalize tags + publish timestamp
    if (typeof patch.tags === 'string') {
      patch.tags = patch.tags.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (patch.status === 'published') {
      patch.publishedAt = new Date();
    }

    // 3) normalize placeholders/empties from incoming patch
    if (patch.imageUrl && isPlaceholderUrl(patch.imageUrl)) {
      delete patch.imageUrl; // force rebuild
    }
    if (patch.imagePublicId !== undefined && String(patch.imagePublicId).trim() === '') {
      delete patch.imagePublicId; // treat as unset
    }

    // 4) load current, merge, then apply strategy and rebuild URLs
    const current = await Article.findById(req.params.id).lean();
    if (!current) return res.status(404).json({ error: 'not_found' });

    const merged = { ...current, ...patch };

    // ensure we always end up with a valid image (match or default)
    await decideAndAttach(merged, { imageStrategy: 'cloudinary', fallbacks: ['stock'] });
    finalizeImageFields(merged);

    // 5) persist merged (only known keys)
    const toSaveKeys = allowed.concat(['publishedAt', 'ogImage', 'thumbImage']);
    const toSave = {};
    for (const k of toSaveKeys) {
      if (merged[k] !== undefined) toSave[k] = merged[k];
    }

    const updated = await Article.findByIdAndUpdate(
      req.params.id,
      { $set: toSave },
      { new: true }
    ).lean();

    if (!updated) return res.status(404).json({ error: 'not_found' });
    res.json(updated);
  } catch (err) {
    console.error('[admin.articles] patch error', err);
    res.status(500).json({ error: 'failed_to_update_article' });
  }
});

// PUBLISH — POST /api/admin/articles/:id/publish
router.post('/:id/publish', async (req, res) => {
  try {
    const updated = await Article.findByIdAndUpdate(
      req.params.id,
      { $set: { status: 'published', publishedAt: new Date() } },
      { new: true }
    ).lean();

    if (!updated) return res.status(404).json({ error: 'not_found' });
    res.json(updated);
  } catch (err) {
    console.error('[admin.articles] publish error', err);
    res.status(500).json({ error: 'failed_to_publish' });
  }
});

module.exports = router;
