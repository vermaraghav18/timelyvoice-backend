// backend/src/routes/admin.articles.routes.js
// Admin routes for listing, previewing, editing and publishing Article drafts

const express = require('express');
const router = express.Router();

// Models
const Article = require('../models/Article');
const Category = require('../models/Category');

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
// CATEGORY NORMALIZATION (so admin never sees ObjectId in UI)

const slugify = require('slugify');

function looksLikeObjectId(val) {
  return typeof val === 'string' && /^[a-f0-9]{24}$/i.test(val);
}

function normalizeArticlesWithCategories(items, categoriesMapById = new Map(), categoriesMapByName = new Map()) {
  return items.map((it) => {
    const a = { ...it };

    // Already populated object?
    if (a.category && typeof a.category === 'object' && (a.category._id || a.category.id || a.category.name)) {
      const id = String(a.category._id || a.category.id || '');
      const name = a.category.name || null;
      const slug = a.category.slug || (name ? slugify(name, { lower: true, strict: true }) : null);
      a.category = name || id ? { id: id || null, name, slug } : null;
      return a;
    }

    // ObjectId string
    if (looksLikeObjectId(a.category)) {
      const c = categoriesMapById.get(String(a.category));
      if (c) {
        a.category = { id: String(c._id), name: c.name || null, slug: c.slug || (c.name ? slugify(c.name, { lower: true, strict: true }) : null) };
      } else {
        a.category = { id: String(a.category), name: null, slug: null };
      }
      return a;
    }

    // Plain string name
    if (typeof a.category === 'string' && a.category.trim()) {
      const name = a.category.trim();
      const c = categoriesMapByName.get(name) || null;
      a.category = {
        id: c ? String(c._id) : null,
        name,
        slug: c?.slug || slugify(name, { lower: true, strict: true })
      };
      return a;
    }

    a.category = null;
    return a;
  });
}

// ────────────────────────────────────────────────────────────────────────────────
// CLOUDINARY PUBLIC ID DERIVER (for pasted image URLs)

function deriveCloudinaryPublicIdFromUrl(url = '') {
  if (typeof url !== 'string' || !url.includes('/image/upload/')) return null;
  try {
    // Example: https://res.cloudinary.com/<cloud>/image/upload/c_fill,w_800/v1723456/folder/name/file.jpg
    const afterUpload = url.split('/image/upload/')[1];
    if (!afterUpload) return null;

    const clean = afterUpload.split(/[?#]/)[0]; // strip query/hash
    const segs = clean.split('/');

    let i = 0;
    // skip transformation segments (contain commas or colon)
    while (i < segs.length && (segs[i].includes(',') || segs[i].includes(':'))) i++;
    // skip version like v12345
    if (i < segs.length && /^v\d+$/i.test(segs[i])) i++;

    const publicPath = segs.slice(i).join('/');
    if (!publicPath) return null;

    return publicPath.replace(/\.[a-z0-9]+$/i, '') || null; // drop extension
  } catch {
    return null;
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

    const rawDrafts = await Article.find(q)
      .select('_id title category slug status summary imageUrl imagePublicId createdAt updatedAt')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    // normalize categories for drafts as well
    const idSet = new Set();
    const nameSet = new Set();
    for (const it of rawDrafts) {
      const c = it.category;
      if (!c) continue;
      if (typeof c === 'object' && (c._id || c.id)) continue;
      if (looksLikeObjectId(c)) idSet.add(String(c));
      else if (typeof c === 'string' && c.trim()) nameSet.add(c.trim());
    }

    const [docsById, docsByName] = await Promise.all([
      idSet.size ? Category.find({ _id: { $in: Array.from(idSet) } }).select('_id name slug').lean() : [],
      nameSet.size ? Category.find({ name: { $in: Array.from(nameSet) } }).select('_id name slug').lean() : [],
    ]);

    const categoriesMapById = new Map((docsById || []).map(d => [String(d._id), d]));
    const categoriesMapByName = new Map((docsByName || []).map(d => [d.name, d]));

    const drafts = normalizeArticlesWithCategories(rawDrafts, categoriesMapById, categoriesMapByName);

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
    if (status) and.push({ status: String(status).toLowerCase() });

    if (category) {
      // allow filtering by slug or name when Article.category may be id or name
      const raw = String(category);
      const catDoc = await Category
        .findOne({ $or: [{ slug: raw }, { slug: slugify(raw) }, { name: raw }] })
        .select('_id name')
        .lean();
      if (catDoc) {
        and.push({ $or: [{ category: catDoc.name }, { category: catDoc._id }] });
      } else {
        and.push({ $or: [{ 'category.slug': raw }, { category: raw }] });
      }
    }

    if (q) {
      const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      and.push({ $or: [{ title: rx }, { summary: rx }, { body: rx }] });
    }

    const query = and.length ? { $and: and } : {};

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const perPage = Math.max(1, Math.min(200, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * perPage;

    const [rawItems, total] = await Promise.all([
      Article.find(query)
        .select('_id title slug status category summary publishedAt updatedAt imageUrl imagePublicId ogImage thumbImage tags')
        .sort({ updatedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(perPage)
        .populate({ path: 'category', select: 'name slug', options: { lean: true } })
        .lean(),
      Article.countDocuments(query),
    ]);

    // normalize categories
    const idSet = new Set();
    const nameSet = new Set();
    for (const it of rawItems) {
      const c = it.category;
      if (!c) continue;
      if (typeof c === 'object' && (c._id || c.id)) continue;
      if (looksLikeObjectId(c)) idSet.add(String(c));
      else if (typeof c === 'string' && c.trim()) nameSet.add(c.trim());
    }

    const [docsById, docsByName] = await Promise.all([
      idSet.size ? Category.find({ _id: { $in: Array.from(idSet) } }).select('_id name slug').lean() : [],
      nameSet.size ? Category.find({ name: { $in: Array.from(nameSet) } }).select('_id name slug').lean() : [],
    ]);

    const categoriesMapById = new Map((docsById || []).map(d => [String(d._id), d]));
    const categoriesMapByName = new Map((docsByName || []).map(d => [d.name, d]));

    const items = normalizeArticlesWithCategories(rawItems, categoriesMapById, categoriesMapByName);

    res.json({ items, total, page: pageNum, limit: perPage });
  } catch (err) {
    console.error('[admin.articles] list error', err);
    res.status(500).json({ error: 'failed_to_list_articles' });
  }
});

// GET ONE — GET /api/admin/articles/:id
router.get('/:id', async (req, res) => {
  try {
    const raw = await Article.findById(req.params.id)
      .populate({ path: 'category', select: 'name slug', options: { lean: true } })
      .lean();
    if (!raw) return res.status(404).json({ error: 'not_found' });

    const items = normalizeArticlesWithCategories([raw]);
    res.json(items[0]);
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
      'ogImage',          // ✅ added
      'thumbImage',       // ✅ added
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

    // 4) load current, merge
    const current = await Article.findById(req.params.id).lean();
    if (!current) return res.status(404).json({ error: 'not_found' });

    const merged = { ...current, ...patch };

    // If a manual URL was provided and no publicId, try to derive one from the URL
    const manualUrlProvided =
      Object.prototype.hasOwnProperty.call(patch, 'imageUrl') &&
      typeof patch.imageUrl === 'string' &&
      patch.imageUrl.trim() !== '' &&
      !patch.imagePublicId;

    if (manualUrlProvided && !merged.imagePublicId) {
      const maybePid = deriveCloudinaryPublicIdFromUrl(merged.imageUrl);
      if (maybePid) {
        merged.imagePublicId = maybePid;
      }
    }

    // ensure we always end up with a valid image (match or default)
    await decideAndAttach(merged, { imageStrategy: 'cloudinary', fallbacks: ['stock'] });
    finalizeImageFields(merged);

    // If still no variants (e.g. non-Cloudinary URL), fall back so admin preview works
    if (!merged.thumbImage && merged.imageUrl) merged.thumbImage = merged.imageUrl;
    if (!merged.ogImage && merged.imageUrl) merged.ogImage = merged.imageUrl;

    // 5) persist merged (only known keys)
    const toSaveKeys = [
      'title','slug','category','summary','imageUrl','imagePublicId','imageAlt',
      'status','tags','body','bodyHtml','author','publishedAt','ogImage','thumbImage'
    ];
    const toSave = {};
    for (const k of toSaveKeys) {
      if (merged[k] !== undefined) toSave[k] = merged[k];
    }

    const updated = await Article.findByIdAndUpdate(
      req.params.id,
      { $set: toSave },
      { new: true }
    )
      .populate({ path: 'category', select: 'name slug', options: { lean: true } })
      .lean();

    if (!updated) return res.status(404).json({ error: 'not_found' });

    // normalize category in patch response too
    const items = normalizeArticlesWithCategories([updated]);
    res.json(items[0]);
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
    )
      .populate({ path: 'category', select: 'name slug', options: { lean: true } })
      .lean();

    if (!updated) return res.status(404).json({ error: 'not_found' });

    // respond immediately to the client (normalized)
    const items = normalizeArticlesWithCategories([updated]);
    res.json(items[0]);

    // fire-and-forget social posting (does not block the response)
    try {
      const { publishEverywhere } = require('../services/socialPublisher');
      Promise.resolve().then(() => publishEverywhere(updated)).catch(() => {});
    } catch (_) {
      // swallow module-load errors silently to avoid breaking publish
    }

  } catch (err) {
    console.error('[admin.articles] publish error', err);
    res.status(500).json({ error: 'failed_to_publish' });
  }
});

module.exports = router;
