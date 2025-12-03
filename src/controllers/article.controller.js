// backend/src/controllers/article.controller.js

const Article = require('../models/Article');
const Category = require('../models/Category');
const slugify = require('slugify');

const { extractTags } = require('../services/textFeatures');
const { uploadDriveImageToCloudinary } = require('../services/googleDriveUploader');
const { decideAndAttach } = require('../services/imageStrategy');
const { chooseHeroImage } = require('../services/imagePicker');
const { buildImageVariants } = require('../services/imageVariants');



// ---------------------------------------------------------
// Helpers
// ---------------------------------------------------------
function escRegex(str = '') {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeEmptyImages(obj = {}) {
  const o = obj;
  if (o.imageUrl === '') o.imageUrl = null;
  if (o.imagePublicId === '') o.imagePublicId = null;
  if (o.ogImage === '') o.ogImage = null;
  if (o.thumbImage === '') o.thumbImage = null;
  return o;
}

function looksLikeObjectId(val) {
  return typeof val === 'string' && /^[a-f0-9]{24}$/i.test(val);
}

function manualUrlProvided(patch) {
  return (
    typeof patch.imageUrl === 'string' &&
    patch.imageUrl.trim() !== '' &&
    (!patch.imagePublicId || patch.imagePublicId === null)
  );
}

function finalizeImageFields(article) {
  if (!article.imagePublicId) return;

  const v = buildImageVariants(article.imagePublicId);

  if (!article.imageUrl) article.imageUrl = v.hero;
  if (!article.ogImage) article.ogImage = v.og;
  if (!article.thumbImage) article.thumbImage = v.thumb;

  if (!article.imageAlt) article.imageAlt = article.title || 'News image';
}


// ---------------------------------------------------------
// LIST ARTICLES (public)
// ---------------------------------------------------------
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
        .select('_id name')
        .lean();

      if (catDoc) {
        q.$or = [
          { category: catDoc.name },
          { category: catDoc._id },
        ];
      } else {
        q.category = raw;
      }
    }

    if (req.query.tag) q.tags = req.query.tag;

    if (req.query.q && String(req.query.q).trim()) {
      const rx = new RegExp(escRegex(String(req.query.q).trim()), 'i');
      q.$or = (q.$or || []).concat([{ title: rx }, { summary: rx }, { slug: rx }]);
    }

    if (String(q.status).toLowerCase() === 'published') {
      q.publishedAt = { $lte: new Date() };
    }

    const PROJECTION = { body: 0, bodyHtml: 0 };
    const SORT = { publishedAt: -1, _id: -1 };

    const cursor = Article
      .find(q, PROJECTION)
      .sort(SORT)
      .skip((page - 1) * limit)
      .limit(limit)
      .populate({ path: 'category', select: 'name slug', options: { lean: true } })
      .lean({ getters: true })
      .maxTimeMS(5000);

    const [rawItems, total] = await Promise.all([
      cursor.exec(),
      Article.countDocuments(q),
    ]);

    res.json({ page, pageSize: rawItems.length, total, items: rawItems });
  } catch (err) {
    console.error('GET /api/articles list error:', err);
    res.status(500).json({ error: 'Failed to list/search articles' });
  }
};


// ---------------------------------------------------------
// GET BY SLUG
// ---------------------------------------------------------
exports.getBySlug = async (req, res) => {
  try {
    const raw = String(req.params.slug || '').trim();
    if (!raw) return res.status(400).json({ error: 'bad_slug' });

    const publishedFilter = { status: 'published', publishedAt: { $lte: new Date() } };

    let doc = await Article.findOne({ slug: raw, ...publishedFilter })
      .populate({ path: 'category', select: 'name slug', options: { lean: true } })
      .lean();

    if (doc) return res.json(doc);

    const rx = new RegExp(`^${escRegex(raw)}(?:-\\d+)?$`, 'i');

    doc = await Article
      .findOne({ slug: rx, ...publishedFilter })
      .sort({ publishedAt: -1, createdAt: -1 })
      .lean();

    if (doc) return res.status(308).json({ redirectTo: `/article/${doc.slug}` });

    return res.status(404).json({ error: 'not_found' });
  } catch (err) {
    console.error('GET /api/articles/slug/* error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
};


// ---------------------------------------------------------
// CREATE ARTICLE (Google Drive → Cloudinary)
// ---------------------------------------------------------
exports.create = async (req, res) => {
  try {
    const payload = normalizeEmptyImages({ ...req.body });

    payload.slug =
      payload.slug ||
      slugify(payload.title || 'article', { lower: true, strict: true }) ||
      `article-${Date.now()}`;

    payload.status = (payload.status || 'draft').toLowerCase();

    if (payload.status === 'published' && !payload.publishedAt) {
      payload.publishedAt = new Date();
    }

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

    const manualOverride = manualUrlProvided(payload);

// AUTO IMAGE (Drive → Cloudinary via imagePicker)
if (!manualOverride && !payload.imagePublicId) {
  const pick = await chooseHeroImage({
    title: payload.title,
    summary: payload.summary,
    category: payload.category,
    tags: payload.tags,
    slug: payload.slug,
  });

  if (pick && pick.publicId) {
    payload.imagePublicId = pick.publicId;
    if (pick.url && !payload.imageUrl) {
      payload.imageUrl = pick.url;
    }
  }
}


    // MANUAL URL → Upload from Drive URL to Cloudinary
    if (manualOverride) {
      const uploaded = await uploadDriveImageToCloudinary(payload.imageUrl, {
        folder: process.env.CLOUDINARY_FOLDER || 'news-images'
      });
      payload.imagePublicId = uploaded.public_id;
      payload.imageUrl = uploaded.secure_url;
    }

    finalizeImageFields(payload);

    const doc = await Article.create(payload);

    res.status(201).json({ ok: true, id: String(doc._id), slug: doc.slug });
  } catch (err) {
    console.error('POST /api/articles create error:', err);
    res.status(500).json({ ok: false, error: String(err.message) });
  }
};


// ---------------------------------------------------------
// UPDATE ARTICLE (Google Drive → Cloudinary)
// ---------------------------------------------------------
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

    doc.status = doc.status.toLowerCase();
    if (doc.status === 'published' && !doc.publishedAt) {
      doc.publishedAt = new Date();
    }

    const manualOverride = manualUrlProvided(patch);

// AUTO IMAGE (Drive → Cloudinary via imagePicker)
if (!manualOverride && !doc.imagePublicId) {
  const pick = await chooseHeroImage({
    title: doc.title,
    summary: doc.summary,
    category: doc.category,
    tags: doc.tags,
    slug: doc.slug,
  });

  if (pick && pick.publicId) {
    doc.imagePublicId = pick.publicId;
    if (pick.url && !doc.imageUrl) {
      doc.imageUrl = pick.url;
    }
  }
}

    if (manualOverride) {
      const uploaded = await uploadDriveImageToCloudinary(doc.imageUrl, {
        folder: process.env.CLOUDINARY_FOLDER || 'news-images'
      });
      doc.imagePublicId = uploaded.public_id;
      doc.imageUrl = uploaded.secure_url;
    }

    finalizeImageFields(doc);

    await doc.save();

    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /api/articles/:id update error:', err);
    res.status(500).json({ ok: false, error: String(err.message) });
  }
};
