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

// Controller for create/import/preview
const ctrl = require('../controllers/admin.articles.controller');

// If you have auth, wire it
// const { requireAuthAdmin } = require('../middleware/auth');

// ────────────────────────────────────────────────────────────────────────────────
// Default image + URL builder (no Cloudinary SDK magic)
// ────────────────────────────────────────────────────────────────────────────────

const DEFAULT_PID =
  process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID ||
  'news-images/defaults/fallback-hero';

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || null;

function buildCloudinaryUrl(publicId, transform = '') {
  if (!CLOUD_NAME || !publicId) return '';
  // transform like 'c_fill,g_auto,h_630,w_1200'
  const base = `https://res.cloudinary.com/${CLOUD_NAME}/image/upload`;
  const t = transform ? `${transform}/` : '';
  return `${base}/${t}${publicId}`;
}

console.log('[admin.articles] DEFAULT_IMAGE_PUBLIC_ID =', DEFAULT_PID);
console.log('[admin.articles] CLOUD_NAME =', CLOUD_NAME);

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
  const publicId = article.imagePublicId || DEFAULT_PID;
  if (!publicId || !CLOUD_NAME) return;

  // hero
  if (!article.imageUrl) {
    article.imageUrl = buildCloudinaryUrl(publicId);
  }

  // og
  if (!article.ogImage) {
    article.ogImage = buildCloudinaryUrl(
      publicId,
      'c_fill,g_auto,h_630,w_1200,f_jpg'
    );
  }

  // thumb
  if (!article.thumbImage) {
    article.thumbImage = buildCloudinaryUrl(
      publicId,
      'c_fill,g_auto,h_300,w_400,f_webp'
    );
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

function normalizeArticlesWithCategories(
  items,
  categoriesMapById = new Map(),
  categoriesMapByName = new Map()
) {
  return items.map((it) => {
    const a = { ...it };

    // Already populated object?
    if (
      a.category &&
      typeof a.category === 'object' &&
      (a.category._id || a.category.id || a.category.name)
    ) {
      const id = String(a.category._id || a.category.id || '');
      const name = a.category.name || null;
      const slug =
        a.category.slug || (name ? slugify(name, { lower: true, strict: true }) : null);
      a.category = name || id ? { id: id || null, name, slug } : null;
      return a;
    }

    // ObjectId string
    if (looksLikeObjectId(a.category)) {
      const c = categoriesMapById.get(String(a.category));
      if (c) {
        a.category = {
          id: String(c._id),
          name: c.name || null,
          slug: c.slug || (c.name ? slugify(c.name, { lower: true, strict: true }) : null),
        };
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
        slug: c?.slug || slugify(name, { lower: true, strict: true }),
      };
      return a;
    }

    a.category = null;
    return a;
  });
}

// Render-safe category text for admin UI cells
const toCatText = (v) =>
  Array.isArray(v)
    ? v.map(toCatText).filter(Boolean)
    : v && typeof v === 'object'
    ? v.name || v.slug || ''
    : v || '';

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

// Normalize remote image URLs (Google Drive → direct download URL)
function normalizeRemoteImageUrl(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return null;

  // If it's a Google Drive link, convert it to a direct download URL
  if (s.includes('drive.google.com')) {
    let fileId = null;

    const byPath = s.match(/\/file\/d\/([^/]+)/);
    if (byPath && byPath[1]) {
      fileId = byPath[1];
    }

    if (!fileId) {
      const byParam = s.match(/[?&]id=([^&]+)/);
      if (byParam && byParam[1]) {
        fileId = byParam[1];
      }
    }

    if (fileId) {
      return `https://drive.google.com/uc?export=download&id=${fileId}`;
    }

    return s;
  }

  return s;
}

// ────────────────────────────────────────────────────────────────────────────────
// CREATE (single) — POST /api/admin/articles
router.post('/', ctrl.createOne);

// BULK IMPORT — POST /api/admin/articles/import
router.post('/import', ctrl.importMany);

// PREVIEW BULK IMPORT (no DB writes) — POST /api/admin/articles/preview-import
router.post('/preview-import', ctrl.previewMany);

// IMPORT IMAGE FROM URL (Cloudinary + Google Drive support)
// POST /api/admin/articles/import-image-from-url
router.post('/import-image-from-url', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string' || !url.trim()) {
      return res.status(400).json({ error: 'url_required' });
    }

    const normalized = normalizeRemoteImageUrl(url);

    const maybePid = deriveCloudinaryPublicIdFromUrl(normalized);
    if (maybePid) {
      const built = buildCloudinaryUrl(maybePid);
      return res.json({
        ok: true,
        publicId: maybePid,
        url: built,
      });
    }

    // If you want uploads-from-URL here, wire it back to lib/cloudinary uploader.
    return res.status(400).json({ error: 'non_cloudinary_url_not_supported_in_dev_mode' });
  } catch (err) {
    console.error('[admin.articles] import-image-from-url failed', err?.message || err);
    return res.status(500).json({ error: 'upload_failed' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// LIST DRAFTS — GET /api/admin/articles/drafts
router.get('/drafts', async (req, res) => {
  try {
    const q = {
      $and: [
        { $or: [{ status: 'draft' }, { status: { $exists: false } }] },
        { $or: [{ publishedAt: { $exists: false } }, { publishedAt: null }] },
      ],
    };

    const rawDrafts = await Article.find(q)
      .select(
        '_id title category slug status summary imageUrl imagePublicId createdAt updatedAt'
      )
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
      idSet.size
        ? Category.find({ _id: { $in: Array.from(idSet) } })
            .select('_id name slug')
            .lean()
        : [],
      nameSet.size
        ? Category.find({ name: { $in: Array.from(nameSet) } })
            .select('_id name slug')
            .lean()
        : [],
    ]);

    const categoriesMapById = new Map((docsById || []).map((d) => [String(d._id), d]));
    const categoriesMapByName = new Map((docsByName || []).map((d) => [d.name, d]));

    const normalizedDrafts = normalizeArticlesWithCategories(
      rawDrafts,
      categoriesMapById,
      categoriesMapByName
    );
    const drafts = normalizedDrafts.map((a) => ({
      ...a,
      category: toCatText(a.category),
      categories: Array.isArray(a.categories) ? a.categories.map(toCatText) : [],
    }));

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
      const raw = String(category);
      const catDoc = await Category.findOne({
        $or: [{ slug: raw }, { slug: slugify(raw) }, { name: raw }],
      })
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
        .select(
          '_id title slug status category summary publishedAt updatedAt imageUrl imagePublicId ogImage thumbImage tags'
        )
        .sort({ publishedAt: -1, updatedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(perPage)
        .populate({
          path: 'category',
          select: 'name slug',
          options: { lean: true },
        })
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
      idSet.size
        ? Category.find({ _id: { $in: Array.from(idSet) } })
            .select('_id name slug')
            .lean()
        : [],
      nameSet.size
        ? Category.find({ name: { $in: Array.from(nameSet) } })
            .select('_id name slug')
            .lean()
        : [],
    ]);

    const categoriesMapById = new Map((docsById || []).map((d) => [String(d._id), d]));
    const categoriesMapByName = new Map((docsByName || []).map((d) => [d.name, d]));

    const normalized = normalizeArticlesWithCategories(
      rawItems,
      categoriesMapById,
      categoriesMapByName
    );
    const items = normalized.map((a) => ({
      ...a,
      category: toCatText(a.category),
      categories: Array.isArray(a.categories) ? a.categories.map(toCatText) : [],
    }));

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
    const a = items[0];
    a.category = toCatText(a.category);
    a.categories = Array.isArray(a.categories) ? a.categories.map(toCatText) : [];
    res.json(a);
  } catch (err) {
    console.error('[admin.articles] get error', err);
    res.status(500).json({ error: 'failed_to_get_article' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// PATCH (fix): normalize placeholders + rebuild image URLs
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
      'ogImage',
      'thumbImage',
      'status',
      'tags',
      'body',
      'bodyHtml',
      'author',
      'year',
      'era',
    ];

    const patch = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) patch[k] = req.body[k];
    }

    if (typeof patch.tags === 'string') {
      patch.tags = patch.tags.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (patch.status === 'published') {
      patch.publishedAt = new Date();
    }

    if (patch.imageUrl && isPlaceholderUrl(patch.imageUrl)) {
      delete patch.imageUrl;
    }
    if (
      patch.imagePublicId !== undefined &&
      String(patch.imagePublicId).trim() === ''
    ) {
      patch.imagePublicId = null;
    }

    const current = await Article.findById(req.params.id).lean();
    if (!current) return res.status(404).json({ error: 'not_found' });

    const merged = { ...current, ...patch };

    if (
      Object.prototype.hasOwnProperty.call(patch, 'imageUrl') &&
      (patch.imageUrl === '' || patch.imageUrl === null)
    ) {
      delete merged.imageUrl;
    }

    if (
      Object.prototype.hasOwnProperty.call(patch, 'imagePublicId') &&
      (patch.imagePublicId === '' || patch.imagePublicId === null)
    ) {
      delete merged.imagePublicId;
    }

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

    await decideAndAttach(merged, { imageStrategy: 'cloudinary', fallbacks: ['stock'] });
    finalizeImageFields(merged);

    if (!merged.thumbImage && merged.imageUrl) merged.thumbImage = merged.imageUrl;
    if (!merged.ogImage && merged.imageUrl) merged.ogImage = merged.imageUrl;

    const toSaveKeys = [
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
      'author',
      'publishedAt',
      'ogImage',
      'thumbImage',
      'year',
      'era',
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

    const items = normalizeArticlesWithCategories([updated]);
    const a = items[0];
    a.category = toCatText(a.category);
    a.categories = Array.isArray(a.categories) ? a.categories.map(toCatText) : [];
    res.json(a);
  } catch (err) {
    console.error('[admin.articles] patch error', err);
    res.status(500).json({ error: 'failed_to_update_article' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// SET DEFAULT IMAGE — POST /api/admin/articles/:id/use-default-image
router.post('/:id/use-default-image', async (req, res) => {
  try {
    const { id } = req.params;

    console.log(
      '[admin.use-default-image] id =',
      id,
      'DEFAULT_PID =',
      DEFAULT_PID,
      'CLOUD_NAME =',
      CLOUD_NAME
    );

    if (!DEFAULT_PID || !CLOUD_NAME) {
      return res.status(500).json({
        ok: false,
        error: 'no_default_image_configured',
      });
    }

    const article = await Article.findById(id);
    if (!article) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    // Force the default image
    article.imagePublicId = DEFAULT_PID;
    article.imageUrl = null;
    article.ogImage = null;
    article.thumbImage = null;

    finalizeImageFields(article);

    console.log('[admin.use-default-image] saved URLs =', {
      imageUrl: article.imageUrl,
      ogImage: article.ogImage,
      thumbImage: article.thumbImage,
    });

    await article.save();

    return res.json({
      ok: true,
      imagePublicId: article.imagePublicId,
      imageUrl: article.imageUrl,
      ogImage: article.ogImage,
      thumbImage: article.thumbImage,
    });
  } catch (err) {
    console.error('[admin.articles] use-default-image error:', err);
    return res
      .status(500)
      .json({ ok: false, error: String(err.message || err) });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
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

    const items = normalizeArticlesWithCategories([updated]);
    const a = items[0];
    a.category = toCatText(a.category);
    a.categories = Array.isArray(a.categories) ? a.categories.map(toCatText) : [];
    res.json(a);

    try {
      const { publishEverywhere } = require('../services/socialPublisher');
      Promise.resolve()
        .then(() => publishEverywhere(updated))
        .catch(() => {});
    } catch (_) {}
  } catch (err) {
    console.error('[admin.articles] publish error', err);
    res.status(500).json({ error: 'failed_to_publish' });
  }
});

module.exports = router;
