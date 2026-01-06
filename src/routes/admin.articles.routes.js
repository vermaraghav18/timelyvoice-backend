// backend/src/routes/admin.articles.routes.js
// Admin routes for listing, previewing, editing and publishing Article drafts

const express = require('express');
const router = express.Router();

// NEW: deps for Drive → Cloudinary override
const fs = require('fs');
const path = require('path');
const { v2: cloudinary } = require('cloudinary');
const { getDriveClient } = require('../services/driveClient');

// Models
const Article = require('../models/Article');
const Category = require('../models/Category');

// Image strategy + variants
const { decideAndAttach } = require('../services/imageStrategy');
const { buildImageVariants } = require('../services/imageVariants');

// 👇 NEW: AI Image service (OpenRouter / Gemini)
const { generateAiHeroForArticle } = require('../services/aiImage.service');

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

// Strip placeholders like "leave it empty" etc. and wrapping quotes
function sanitizeImageUrl(u) {
  if (!u) return '';
  let s = String(u).trim();
  if (!s) return '';

  // strip wrapping single/double quotes if present
  s = s.replace(/^['"]+|['"]+$/g, '').trim();
  if (!s) return '';

  const lower = s.toLowerCase();

  if (
    /^leave\s+(it|this)?\s*empty$/.test(lower) ||
    lower === 'leave empty' ||
    lower === 'none' ||
    lower === 'n/a'
  ) {
    return '';
  }

  return s;
}

console.log('[admin.articles] DEFAULT_IMAGE_PUBLIC_ID =', DEFAULT_PID);
console.log('[admin.articles] CLOUD_NAME =', CLOUD_NAME);

// ────────────────────────────────────────────────────────────────────────────────
// NEW: Cloudinary + Drive setup for manual Drive overrides
// ────────────────────────────────────────────────────────────────────────────────

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const TEMP_DIR = path.join(__dirname, '../../tmp-drive-manual');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const { drive, credSource } = getDriveClient
  ? getDriveClient()
  : { drive: null, credSource: 'none' };

// Extract fileId from common Google Drive URLs
function extractDriveFileId(raw = '') {
  const s = String(raw || '').trim();
  if (!s.includes('drive.google.com')) return null;

  // /file/d/<ID>/view
  const byPath = s.match(/\/file\/d\/([^/]+)/);
  if (byPath && byPath[1]) return byPath[1];

  // ?id=<ID> or &id=<ID>
  const byParam = s.match(/[?&]id=([^&]+)/);
  if (byParam && byParam[1]) return byParam[1];

  return null;
}

// Download a Drive file by ID → upload to Cloudinary → return { publicId, url }
async function uploadDriveFileToCloudinary(fileId) {
  if (!fileId || !drive) {
    console.warn(
      '[admin.articles] uploadDriveFileToCloudinary: missing fileId or drive client; credSource =',
      credSource
    );
    return null;
  }

  const destPath = path.join(TEMP_DIR, `${fileId}.img`);
  const dest = fs.createWriteStream(destPath);

  try {
    const response = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    await new Promise((resolve, reject) => {
      response.data.on('end', resolve).on('error', reject).pipe(dest);
    });

    const uploaded = await cloudinary.uploader.upload(destPath, {
      folder: process.env.CLOUDINARY_FOLDER
        ? `${process.env.CLOUDINARY_FOLDER}/manual`
        : 'news-images/manual',
      resource_type: 'image',
    });

    try {
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    } catch (err) {
      console.warn('[admin.articles] temp cleanup warning:', err.message || err);
    }

    return {
      publicId: uploaded.public_id,
      url: uploaded.secure_url,
    };
  } catch (err) {
    console.error(
      '[admin.articles] uploadDriveFileToCloudinary error:',
      err.message || err
    );
    try {
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    } catch (_) {}
    return null;
  }
}

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

  // Clean out any junk markers like "leave it empty"
  article.imageUrl = sanitizeImageUrl(article.imageUrl);
  article.ogImage = sanitizeImageUrl(article.ogImage);
  article.thumbImage = sanitizeImageUrl(article.thumbImage);

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
        a.category.slug ||
        (name ? slugify(name, { lower: true, strict: true }) : null);
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
          slug:
            c.slug ||
            (c.name ? slugify(c.name, { lower: true, strict: true }) : null),
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
    while (i < segs.length && (segs[i].includes(',') || segs[i].includes(':')))
      i++;
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
    const fileId = extractDriveFileId(s);
    if (fileId) {
      return `https://drive.google.com/uc?export=download&id=${fileId}`;
    }
    return s;
  }

  return s;
}

// ────────────────────────────────────────────────────────────────────────────────
// CREATE (single) — POST /api/admin/articles
// Wrap createOne so that CREATE always ignores incoming image fields and
// forces auto-pick from Drive / strategy layer.
router.post('/', async (req, res, next) => {
  try {
    if (req.body && typeof req.body === 'object') {
      const scrubKeys = ['imageUrl', 'imagePublicId', 'ogImage', 'thumbImage'];

      for (const key of scrubKeys) {
        if (Object.prototype.hasOwnProperty.call(req.body, key)) {
          delete req.body[key];
        }
      }
    }

    return ctrl.createOne(req, res, next);
  } catch (err) {
    console.error('[admin.articles] create wrapper error', err);
    return res.status(500).json({ error: 'failed_to_create_article' });
  }
});

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

    return res
      .status(400)
      .json({ error: 'non_cloudinary_url_not_supported_in_dev_mode' });
  } catch (err) {
    console.error(
      '[admin.articles] import-image-from-url failed',
      err?.message || err
    );
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
        '_id title slug status category summary homepagePlacement body publishedAt updatedAt createdAt imageUrl imagePublicId ogImage thumbImage imageAlt tags source sourceUrl videoUrl'
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

    const categoriesMapById = new Map(
      (docsById || []).map((d) => [String(d._id), d])
    );
    const categoriesMapByName = new Map(
      (docsByName || []).map((d) => [d.name, d])
    );

    const normalizedDrafts = normalizeArticlesWithCategories(
      rawDrafts,
      categoriesMapById,
      categoriesMapByName
    );
    const drafts = normalizedDrafts.map((a) => {
      const clean = sanitizeImageUrl(a.imageUrl);
      const bestPid = a.imagePublicId || DEFAULT_PID;
      const imageUrl =
        clean || (bestPid && CLOUD_NAME ? buildCloudinaryUrl(bestPid) : '');

      return {
        ...a,
        imageUrl,
        category: toCatText(a.category),
        categories: Array.isArray(a.categories)
          ? a.categories.map(toCatText)
          : [],
      };
    });

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

// ────────────────────────────────────────────────────────────────────────────────
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

    const MAX_LIST = 1000;

    const [allItems, total] = await Promise.all([
      Article.find(query)
        .select(
          '_id title slug status category summary homepagePlacement body publishedAt updatedAt createdAt imageUrl imagePublicId ogImage thumbImage imageAlt tags source sourceUrl videoUrl'
        )
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(MAX_LIST)
        .populate({
          path: 'category',
          select: 'name slug',
          options: { lean: true },
        })
        .lean(),
      Article.countDocuments(query),
    ]);

    function getSortDate(doc) {
      const candidate =
        (doc.publishedAt && new Date(doc.publishedAt)) ||
        (doc.updatedAt && new Date(doc.updatedAt)) ||
        (doc.createdAt && new Date(doc.createdAt));
      if (!candidate || Number.isNaN(candidate.getTime())) return new Date(0);
      return candidate;
    }

    const sorted = (allItems || []).slice().sort((a, b) => {
      const aStatus = (a.status || '').toString().toLowerCase();
      const bStatus = (b.status || '').toString().toLowerCase();
      const aIsDraft = !aStatus || aStatus === 'draft';
      const bIsDraft = !bStatus || bStatus === 'draft';

      if (aIsDraft !== bIsDraft) return aIsDraft ? -1 : 1;

      const da = getSortDate(a);
      const db = getSortDate(b);
      return db - da;
    });

    const paged = sorted.slice(skip, skip + perPage);

    const idSet = new Set();
    const nameSet = new Set();
    for (const it of paged) {
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

    const categoriesMapById = new Map(
      (docsById || []).map((d) => [String(d._id), d])
    );
    const categoriesMapByName = new Map(
      (docsByName || []).map((d) => [d.name, d])
    );

    const normalized = normalizeArticlesWithCategories(
      paged,
      categoriesMapById,
      categoriesMapByName
    );

    const items = normalized.map((a) => {
      const cleaned = sanitizeImageUrl(a.imageUrl);
      const bestPid = a.imagePublicId || DEFAULT_PID;

      const imageUrl =
        cleaned || (bestPid && CLOUD_NAME ? buildCloudinaryUrl(bestPid) : '');

      const imageAlt = a.imageAlt || a.title || 'News image';

      return {
        ...a,
        imageUrl,
        imageAlt,
        category: toCatText(a.category),
        categories: Array.isArray(a.categories)
          ? a.categories.map(toCatText)
          : [],
      };
    });

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

    const cleaned = sanitizeImageUrl(a.imageUrl);
    const bestPid = a.imagePublicId || DEFAULT_PID;
    a.imageUrl =
      cleaned || (bestPid && CLOUD_NAME ? buildCloudinaryUrl(bestPid) : '');

    a.category = toCatText(a.category);
    a.categories = Array.isArray(a.categories)
      ? a.categories.map(toCatText)
      : [];
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
      'categorySlug', // ✅ MUST exist to save it
      'summary',
      'homepagePlacement',
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
      'videoUrl',
      'videoPublicId',
      'videoSourceUrl',
    ];

    const patch = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) patch[k] = req.body[k];
    }

    // ✅ FIX: keep categorySlug always synced
    // If category changes, force categorySlug = slugify(category)
    if (
      Object.prototype.hasOwnProperty.call(patch, 'category') ||
      Object.prototype.hasOwnProperty.call(patch, 'categorySlug')
    ) {
      const catName = String(patch.category || '').trim();

      if (catName) {
        patch.categorySlug = slugify(catName, { lower: true, strict: true });
      } else if (patch.categorySlug) {
        patch.categorySlug = slugify(String(patch.categorySlug), {
          lower: true,
          strict: true,
        });
      } else {
        patch.categorySlug = '';
      }
    }

    if (typeof patch.tags === 'string') {
      patch.tags = patch.tags.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (patch.status === 'published') {
      patch.publishedAt = new Date();
    }

    if (patch.imageUrl !== undefined) {
      const cleaned = sanitizeImageUrl(patch.imageUrl);
      if (!cleaned || isPlaceholderUrl(cleaned)) {
        delete patch.imageUrl;
      } else {
        patch.imageUrl = cleaned;
      }
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

    // NEW: if manual URL is a Google Drive link, resolve it to Cloudinary first
    if (
      merged.imageUrl &&
      typeof merged.imageUrl === 'string' &&
      merged.imageUrl.includes('drive.google.com')
    ) {
      try {
        const fileId = extractDriveFileId(merged.imageUrl);
        if (fileId) {
          const uploaded = await uploadDriveFileToCloudinary(fileId);
          if (uploaded) {
            merged.imagePublicId = uploaded.publicId;
            merged.imageUrl = uploaded.url;
            patch.imagePublicId = uploaded.publicId;
            patch.imageUrl = uploaded.url;
          }
        }
      } catch (err) {
        console.error(
          '[admin.articles] manual Drive image override failed:',
          err.message || err
        );
      }
    }

    // ✅ NEW: if videoUrl is a Google Drive link, convert it to Cloudinary video
    if (
      merged.videoUrl &&
      typeof merged.videoUrl === 'string' &&
      merged.videoUrl.includes('drive.google.com')
    ) {
      try {
        const fileId = extractDriveFileId(merged.videoUrl);
        if (fileId) {
          // stream Drive file → Cloudinary video
          const destPath = path.join(TEMP_DIR, `${fileId}.video`);
          const dest = fs.createWriteStream(destPath);

          const response = await drive.files.get(
            { fileId, alt: 'media' },
            { responseType: 'stream' }
          );

          await new Promise((resolve, reject) => {
            response.data.on('end', resolve).on('error', reject).pipe(dest);
          });

          const uploaded = await cloudinary.uploader.upload(destPath, {
            folder: process.env.CLOUDINARY_VIDEO_FOLDER || 'news-videos/manual',
            resource_type: 'video',
          });

          try {
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
          } catch (_) {}

          merged.videoSourceUrl = merged.videoUrl;
          merged.videoPublicId = uploaded.public_id;
          merged.videoUrl = uploaded.secure_url;

          patch.videoSourceUrl = merged.videoSourceUrl;
          patch.videoPublicId = merged.videoPublicId;
          patch.videoUrl = merged.videoUrl;
        }
      } catch (err) {
        console.error(
          '[admin.articles] Drive video override failed:',
          err.message || err
        );
      }
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

    await decideAndAttach(merged, {
      imageStrategy: 'cloudinary',
      fallbacks: ['stock'],
    });
    finalizeImageFields(merged);

    if (!merged.thumbImage && merged.imageUrl) merged.thumbImage = merged.imageUrl;
    if (!merged.ogImage && merged.imageUrl) merged.ogImage = merged.imageUrl;

    const toSaveKeys = [
      'title',
      'slug',
      'category',
      'categorySlug', // ✅ MUST SAVE THIS
      'summary',
      'homepagePlacement',
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
      'videoUrl',
      'videoPublicId',
      'videoSourceUrl',
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

    const cleanedUrl = sanitizeImageUrl(a.imageUrl);
    const bestPid = a.imagePublicId || DEFAULT_PID;
    a.imageUrl =
      cleanedUrl || (bestPid && CLOUD_NAME ? buildCloudinaryUrl(bestPid) : '');

    a.category = toCatText(a.category);
    a.categories = Array.isArray(a.categories)
      ? a.categories.map(toCatText)
      : [];
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
    const cleanedUrl = sanitizeImageUrl(a.imageUrl);
    const bestPid = a.imagePublicId || DEFAULT_PID;
    a.imageUrl =
      cleanedUrl || (bestPid && CLOUD_NAME ? buildCloudinaryUrl(bestPid) : '');
    a.category = toCatText(a.category);
    a.categories = Array.isArray(a.categories)
      ? a.categories.map(toCatText)
      : [];
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

// ────────────────────────────────────────────────────────────────────────────────
// AI IMAGE — POST /api/admin/articles/:id/ai-image
router.post('/:id/ai-image', async (req, res) => {
  try {
    if (process.env.AI_IMAGE_ENABLED === 'false') {
      return res.status(403).json({
        ok: false,
        error: 'ai_image_disabled',
      });
    }

    const { id } = req.params;
    const result = await generateAiHeroForArticle(id);

    if (!result) {
      return res.status(404).json({
        ok: false,
        error: 'ai_image_failed',
      });
    }

    return res.json({
      ok: true,
      articleId: result.articleId || id,
      imageUrl: result.imageUrl,
      imagePublicId: result.imagePublicId,
      ogImage: result.ogImage,
      thumbImage: result.thumbImage,
    });
  } catch (err) {
    console.error('[admin.articles] /:id/ai-image error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || 'ai_image_failed',
    });
  }
});

module.exports = router;
