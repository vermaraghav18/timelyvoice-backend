// backend/src/controllers/admin.articles.controller.js
const Article = require('../models/Article');
const { decideAndAttach } = require('../services/imageStrategy');
const { buildImageVariants } = require('../services/imageVariants');
const cloudinary = require('cloudinary').v2;

// ────────────────────────────────────────────────────────────────────────────────
// URL-safe slug generator
const slugify = (s) =>
  s.toString()
    .toLowerCase()
    .trim()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// Treat typical placeholders as “empty” so fallback can apply
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
    // Invalid URL → treat as placeholder so server will replace it
    return true;
  }
}

function isPlaceholderPublicId(pid = '') {
  if (!pid) return true;
  const s = String(pid).toLowerCase();
  // treat obvious fakes/examples as placeholders, but don't nuke real dated ids
  return (
    s.includes('placeholder') ||
    s.includes('example') ||
    s === 'news/example' ||
    s === 'news/default'
  );
}

// Ensure we always have some publicId before building final URLs
function ensurePublicId(article) {
  if (!article) return;
  if (!article.imagePublicId || isPlaceholderPublicId(article.imagePublicId)) {
    const DEFAULT_PID =
      process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID ||
      'news-images/default-hero'; // <-- put your real default folder/public id here
    article.imagePublicId = DEFAULT_PID;
  }
}

function normalizeIncomingArticle(raw = {}) {
  const a = { ...raw };

  a.status   = a.status || 'draft';
  a.title    = a.title?.trim();
  a.slug     = a.slug?.trim();
  a.category = a.category?.trim();

  // auto-slug if missing
  if (!a.slug && a.title) a.slug = slugify(a.title);

  if (!Array.isArray(a.tags) && typeof a.tags === 'string') {
    a.tags = a.tags.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(a.tags)) a.tags = [];

  // Always ignore any incoming image fields; server decides images
  delete a.imageUrl;
  delete a.ogImage;
  delete a.thumbImage;

  if (isPlaceholderPublicId(a.imagePublicId)) {
    delete a.imagePublicId;
  }

  // Optional: if client wants to *force* default image, allow a flag
  if (a.forceDefaultImage === true) {
    delete a.imagePublicId;
  }

  return a;
}

// Only allow known strategies
function sanitizeStrategy(s) {
  const v = String(s || '').toLowerCase();
  return v === 'stock' ? 'stock' : 'cloudinary';
}

// Build final URLs (hero/og/thumb) from imagePublicId or default
function finalizeImageFields(article) {
  if (!article) return;

  // guarantee a usable public id
  ensurePublicId(article);
  const publicId = article.imagePublicId;
  if (!publicId) return; // defensive: should not happen

  try {
    const variants = buildImageVariants(publicId);
    if (variants && typeof variants === 'object') {
      if (!article.imageUrl)
        article.imageUrl =
          variants.hero || variants.base || cloudinary.url(publicId, { secure: true });
      if (!article.ogImage)
        article.ogImage =
          variants.og ||
          cloudinary.url(publicId, {
            width: 1200,
            height: 630,
            crop: 'fill',
            gravity: 'auto',
            format: 'jpg',
            secure: true,
          });
      if (!article.thumbImage)
        article.thumbImage =
          variants.thumb ||
          cloudinary.url(publicId, {
            width: 400,
            height: 300,
            crop: 'fill',
            gravity: 'auto',
            format: 'webp',
            secure: true,
          });
    } else {
      if (!article.imageUrl)
        article.imageUrl = cloudinary.url(publicId, { secure: true });
      if (!article.ogImage)
        article.ogImage = cloudinary.url(publicId, {
          width: 1200,
          height: 630,
          crop: 'fill',
          gravity: 'auto',
          format: 'jpg',
          secure: true,
        });
      if (!article.thumbImage)
        article.thumbImage = cloudinary.url(publicId, {
          width: 400,
          height: 300,
          crop: 'fill',
          gravity: 'auto',
          format: 'webp',
          secure: true,
        });
    }
  } catch {
    // super safe fallback
    if (!article.imageUrl)
      article.imageUrl = cloudinary.url(publicId, { secure: true });
    if (!article.ogImage)
      article.ogImage = cloudinary.url(publicId, {
        width: 1200,
        height: 630,
        crop: 'fill',
        gravity: 'auto',
        format: 'jpg',
        secure: true,
      });
    if (!article.thumbImage)
      article.thumbImage = cloudinary.url(publicId, {
        width: 400,
        height: 300,
        crop: 'fill',
        gravity: 'auto',
        format: 'webp',
        secure: true,
      });
  }

  if (!article.imageAlt) {
    article.imageAlt = article.title || 'News image';
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// OPTIONAL: auto-pick by slug from Cloudinary (Admin Search API)
// Enable with CLOUDINARY_AUTOPICK=on and set CLOUDINARY_FOLDER
async function maybeAutopickBySlug(article) {
  const AUTOPICK = String(process.env.CLOUDINARY_AUTOPICK || '').toLowerCase() === 'on';
  const FOLDER = process.env.CLOUDINARY_FOLDER || 'news-images';
  if (!AUTOPICK || !article?.slug || article.imagePublicId) return;

  try {
    const expr = `folder:${FOLDER} AND (public_id:${FOLDER}/${article.slug}* OR filename:${article.slug}*)`;
    const res = await cloudinary.search.expression(expr).max_results(5).execute();

    if (res?.resources?.length) {
      // pick the first; you can add better ranking if you want
      const pick = res.resources[0];
      article.imagePublicId = pick.public_id;
    }
  } catch (e) {
    console.warn('[autopick] Cloudinary search failed:', e?.message || e);
  }
}

// ────────────────────────────────────────────────────────────────────────────────
exports.createOne = async (req, res) => {
  try {
    const article = normalizeIncomingArticle(req.body);
    const primary = sanitizeStrategy(req.body?.imageStrategy);

    // Try to auto-pick only if nothing set yet
    if (!article.imagePublicId && !article.imageUrl) {
      await maybeAutopickBySlug(article); // optional
    }

    // IMPORTANT: merge what decideAndAttach returns
    const img = await decideAndAttach(article, { imageStrategy: primary, fallbacks: ['stock'] });
    if (img && typeof img === 'object') Object.assign(article, img);

    // Always guarantee a usable publicId and build URLs
    finalizeImageFields(article);

    const saved = await Article.create(article);
    return res.json({ ok: true, id: saved._id, slug: saved.slug });
  } catch (err) {
    console.error('[admin.articles] createOne error:', err);
    return res.status(400).json({ ok: false, error: String(err?.message || err) });
  }
};

exports.importMany = async (req, res) => {
  try {
    const {
      items = [],
      imageStrategy = 'cloudinary',
      continueOnError = true,
      forceDefaultImage = false, // optional bulk switch
    } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'items[] required' });
    }

    const primary = sanitizeStrategy(imageStrategy);
    const results = [];

    for (const raw of items) {
      try {
        const article = normalizeIncomingArticle({
          ...raw,
          ...(forceDefaultImage ? { forceDefaultImage: true } : {}),
        });

        if (!article.imagePublicId && !article.imageUrl) {
          await maybeAutopickBySlug(article); // optional
        }

        const img = await decideAndAttach(article, {
          imageStrategy: primary,
          fallbacks: ['stock'],
        });
        if (img && typeof img === 'object') Object.assign(article, img);

        finalizeImageFields(article);

        const saved = await Article.create(article);
        results.push({ ok: true, id: saved._id, slug: saved.slug });
      } catch (e) {
        const errMsg = String(e?.message || e);
        console.error('[admin.articles] import item failed:', errMsg);
        if (!continueOnError) {
          return res.status(400).json({ ok: false, error: errMsg, results });
        }
        results.push({ ok: false, error: errMsg });
      }
    }

    return res.json({ ok: true, results });
  } catch (err) {
    console.error('[admin.articles] importMany error:', err);
    return res.status(400).json({ ok: false, error: String(err?.message || err) });
  }
};

exports.previewMany = async (req, res) => {
  try {
    const { items = [], imageStrategy = 'cloudinary' } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'items[] required' });
    }

    const primary = sanitizeStrategy(imageStrategy);
    const previews = [];

    for (let i = 0; i < items.length; i++) {
      const raw = items[i];
      const article = normalizeIncomingArticle(raw);

      if (!article.imagePublicId && !article.imageUrl) {
        await maybeAutopickBySlug(article); // optional
      }

      const img = await decideAndAttach(article, { imageStrategy: primary, fallbacks: ['stock'] });
      if (img && typeof img === 'object') Object.assign(article, img);

      finalizeImageFields(article);

      previews.push({
        index: i,
        title: article.title,
        slug: article.slug,
        category: article.category,
        imagePublicId: article.imagePublicId || null,
        imageUrl: article.imageUrl || null,
        ogImage: article.ogImage || null,
        imageAlt: article.imageAlt || (article.title || ''),
      });
    }

    return res.json({ ok: true, previews });
  } catch (err) {
    console.error('[admin.articles] previewMany error:', err);
    return res.status(400).json({ ok: false, error: String(err?.message || err) });
  }
};
