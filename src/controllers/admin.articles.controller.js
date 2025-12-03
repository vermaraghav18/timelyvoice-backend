// backend/src/controllers/admin.articles.controller.js

const Article = require('../models/Article');
const { buildImageVariants } = require('../services/imageVariants');
const { decideAndAttach } = require('../services/imageStrategy');
const { uploadDriveImageToCloudinary } = require('../services/googleDriveUploader');
const { chooseHeroImage } = require('../services/imagePicker');
const slugify = require('slugify');

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
const PLACEHOLDER_HOSTS = ['example.com', 'cdn.example', 'your-cdn.example'];

function isPlaceholderUrl(url = '') {
  if (!url) return true;
  try {
    const { hostname } = new URL(url);
    return (
      !hostname ||
      PLACEHOLDER_HOSTS.includes(hostname) ||
      hostname.includes('example')
    );
  } catch {
    return true;
  }
}

function isPlaceholderPublicId(pid = '') {
  if (!pid) return true;
  const s = pid.toLowerCase();
  const def =
    (process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID ||
      'news-images/defaults/fallback-hero').toLowerCase();

  if (s === def) return true;
  return (
    s.includes('placeholder') ||
    s.includes('example') ||
    s === 'news/default'
  );
}

function ensureSlug(a) {
  if (!a.slug && a.title) {
    a.slug = slugify(a.title, { lower: true, strict: true });
  }
}

function normalizeIncoming(raw = {}) {
  const a = { ...raw };

  a.status = a.status || 'draft';
  a.title = a.title?.trim();
  a.slug = a.slug?.trim();
  a.category = a.category?.trim();

  if (!Array.isArray(a.tags) && typeof a.tags === 'string') {
    a.tags = a.tags.split(',').map(t => t.trim()).filter(Boolean);
  }
  if (!Array.isArray(a.tags)) a.tags = [];

  if (isPlaceholderPublicId(a.imagePublicId)) delete a.imagePublicId;
  if (isPlaceholderUrl(a.imageUrl)) delete a.imageUrl;

  return a;
}

// Build final url variants from Cloudinary publicId
function finalizeImageFields(article) {
  if (!article.imagePublicId) return;

  const vars = buildImageVariants(article.imagePublicId);

  if (!article.imageUrl) article.imageUrl = vars.hero;
  if (!article.ogImage) article.ogImage = vars.og;
  if (!article.thumbImage) article.thumbImage = vars.thumb;

  if (!article.imageAlt) {
    article.imageAlt = article.title || 'News image';
  }
}

// ─────────────────────────────────────────────────────────────
// CREATE ARTICLE — FULL GOOGLE DRIVE → CLOUDINARY SUPPORT
// ─────────────────────────────────────────────────────────────
exports.createOne = async (req, res) => {
  try {
    let article = normalizeIncoming(req.body);

    ensureSlug(article);

    article.status = article.status.toLowerCase();
    if (article.status === 'published' && !article.publishedAt) {
      article.publishedAt = new Date();
    }

    // ✔️ FIXED LOGIC: Only real URLs bypass the auto-picker
    const manualUrlProvided =
      typeof article.imageUrl === 'string' &&
      article.imageUrl.trim().startsWith('http') &&
      !article.imagePublicId;

    // AUTO PICK
    if (!manualUrlProvided && !article.imagePublicId) {
      const pick = await chooseHeroImage({
        title: article.title,
        summary: article.summary,
        category: article.category,
        tags: article.tags,
        slug: article.slug,
      });

      if (pick) {
        console.log('[imagePicker] createOne chooseHeroImage:', {
          title: article.title,
          why: pick.why,
          publicId: pick.publicId,
          url: pick.url,
        });
      }

      if (pick && pick.publicId) {
        article.imagePublicId = pick.publicId;
        if (pick.url && !article.imageUrl) {
          article.imageUrl = pick.url;
        }
      }
    }

    // Manual URL provided (actual URL)
    if (manualUrlProvided) {
      const uploaded = await uploadDriveImageToCloudinary(article.imageUrl, {
        folder: process.env.CLOUDINARY_FOLDER || 'news-images',
      });
      article.imagePublicId = uploaded.public_id;
      article.imageUrl = uploaded.secure_url;
    }

    finalizeImageFields(article);

    const saved = await Article.create(article);

    return res.json({ ok: true, id: saved._id, slug: saved.slug });
  } catch (err) {
    console.error('[admin.articles] createOne error:', err);
    return res.status(500).json({ ok: false, error: String(err.message) });
  }
};

// ─────────────────────────────────────────────────────────────
// IMPORT MANY
// ─────────────────────────────────────────────────────────────
exports.importMany = async (req, res) => {
  try {
    const { items = [] } = req.body || {};
    const results = [];

    for (const raw of items) {
      try {
        let article = normalizeIncoming(raw);
        ensureSlug(article);

        article.status = article.status.toLowerCase();
        if (article.status === 'published' && !article.publishedAt) {
          article.publishedAt = new Date();
        }

        // ✔️ FIXED LOGIC HERE TOO
        const manualUrlProvided =
          typeof article.imageUrl === 'string' &&
          article.imageUrl.trim().startsWith('http') &&
          !article.imagePublicId;

        if (!manualUrlProvided && !article.imagePublicId) {
          const pick = await chooseHeroImage({
            title: article.title,
            summary: article.summary,
            category: article.category,
            tags: article.tags,
            slug: article.slug,
          });

          if (pick) {
            console.log('[imagePicker] importMany chooseHeroImage:', {
              title: article.title,
              why: pick.why,
              publicId: pick.publicId,
              url: pick.url,
            });
          }

          if (pick && pick.publicId) {
            article.imagePublicId = pick.publicId;
            if (pick.url && !article.imageUrl) {
              article.imageUrl = pick.url;
            }
          }
        }

        if (manualUrlProvided) {
          const uploaded = await uploadDriveImageToCloudinary(article.imageUrl, {
            folder: process.env.CLOUDINARY_FOLDER || 'news-images',
          });
          article.imagePublicId = uploaded.public_id;
          article.imageUrl = uploaded.secure_url;
        }

        finalizeImageFields(article);

        const saved = await Article.create(article);
        results.push({ ok: true, id: saved._id, slug: saved.slug });
      } catch (e) {
        results.push({ ok: false, error: String(e.message) });
      }
    }

    return res.json({ ok: true, results });
  } catch (err) {
    console.error('[importMany]', err);
    return res.status(500).json({ ok: false, error: String(err.message) });
  }
};

// ─────────────────────────────────────────────────────────────
// PREVIEW MANY
// ─────────────────────────────────────────────────────────────
exports.previewMany = async (req, res) => {
  try {
    const { items = [] } = req.body || {};
    const previews = [];

    for (const raw of items) {
      let article = normalizeIncoming(raw);
      ensureSlug(article);

      // ✔️ FIX APPLIED HERE ALSO
      const manualUrlProvided =
        typeof article.imageUrl === 'string' &&
        article.imageUrl.trim().startsWith('http') &&
        !article.imagePublicId;

      if (!manualUrlProvided && !article.imagePublicId) {
        const pick = await chooseHeroImage({
          title: article.title,
          summary: article.summary,
          category: article.category,
          tags: article.tags,
          slug: article.slug,
        });

        if (pick) {
          console.log('[imagePicker] previewMany chooseHeroImage:', {
            title: article.title,
            why: pick.why,
            publicId: pick.publicId,
            url: pick.url,
          });
        }

        if (pick && pick.publicId) {
          article.imagePublicId = pick.publicId;
          if (pick.url && !article.imageUrl) {
            article.imageUrl = pick.url;
          }
        }
      }

      if (manualUrlProvided) {
        const uploaded = await uploadDriveImageToCloudinary(article.imageUrl, {
          folder: process.env.CLOUDINARY_FOLDER || 'news-images',
        });
        article.imagePublicId = uploaded.public_id;
        article.imageUrl = uploaded.secure_url;
      }

      finalizeImageFields(article);

      previews.push({
        title: article.title,
        slug: article.slug,
        imagePublicId: article.imagePublicId,
        imageUrl: article.imageUrl,
        ogImage: article.ogImage,
      });
    }

    res.json({ ok: true, previews });
  } catch (err) {
    console.error('[previewMany]', err);
    res.status(500).json({ ok: false, error: String(err.message) });
  }
};
