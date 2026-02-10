// backend/src/controllers/article.controller.js

const Article = require("../models/Article");
const slugify = require("slugify");

const { extractTags } = require("../services/textFeatures");
const { finalizeArticleImages } = require("../services/finalizeArticleImages");
const { buildImageVariants } = require("../services/imageVariants");

// ---------------------------------------------------------
// Helpers
// ---------------------------------------------------------
function normalizeEmptyImages(obj = {}) {
  const o = obj;
  if (o.imageUrl === "") o.imageUrl = null;
  if (o.imagePublicId === "") o.imagePublicId = null;
  if (o.ogImage === "") o.ogImage = null;
  if (o.thumbImage === "") o.thumbImage = null;
  return o;
}

function normSlug(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  return slugify(s, { lower: true, strict: true });
}

function syncCategorySlug(obj) {
  let catText = "";

  const c = obj?.category;
  if (typeof c === "string") catText = c;
  else if (c && typeof c === "object") catText = c.slug || c.name || "";

  const incomingSlug = obj?.categorySlug;

  if (incomingSlug !== undefined && incomingSlug !== null && String(incomingSlug).trim()) {
    obj.categorySlug = normSlug(incomingSlug);
    return;
  }

  if (catText && String(catText).trim()) {
    obj.categorySlug = normSlug(catText);
  }
}

function finalizeImageFields(article) {
  if (!article.imagePublicId) return;

  const v = buildImageVariants(article.imagePublicId);

  if (!article.imageUrl) article.imageUrl = v.hero;
  if (!article.ogImage) article.ogImage = v.og;
  if (!article.thumbImage) article.thumbImage = v.thumb;

  if (!article.imageAlt) article.imageAlt = article.title || "News image";
}

// ---------------------------------------------------------
// LIST ARTICLES
// ---------------------------------------------------------
exports.list = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limitReq = Math.max(parseInt(req.query.limit || "0", 10), 0);
    const limit = Math.min(limitReq || 12, 300);

    const q = {};
    q.status = (req.query.status || "published").toLowerCase();

    if (req.query.category) {
      const raw = String(req.query.category).trim();
      const rawSlug = normSlug(raw);
      q.$and = q.$and || [];
      q.$and.push({
        $or: [{ category: raw }, { category: rawSlug }, { categorySlug: rawSlug }],
      });
    }

    const PROJECTION = { body: 0, bodyHtml: 0 };
    const SORT = { publishedAt: -1, updatedAt: -1, createdAt: -1, _id: -1 };

    const [items, total] = await Promise.all([
      Article.find(q, PROJECTION).sort(SORT).skip((page - 1) * limit).limit(limit).lean(),
      Article.countDocuments(q),
    ]);

    res.json({ page, pageSize: items.length, total, items });
  } catch (err) {
    res.status(500).json({ error: "Failed to list articles" });
  }
};

// ---------------------------------------------------------
// GET BY SLUG
// ---------------------------------------------------------
exports.getBySlug = async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    if (!slug) return res.status(400).json({ error: "bad_slug" });

    const doc = await Article.findOne({ slug, status: "published" }).lean();
    if (!doc) return res.status(404).json({ error: "not_found" });

    res.json(doc);
  } catch {
    res.status(500).json({ error: "server_error" });
  }
};

// ---------------------------------------------------------
// CREATE ARTICLE
// ---------------------------------------------------------
exports.create = async (req, res) => {
  try {
    const payload = normalizeEmptyImages({ ...req.body });

    payload.slug =
      payload.slug ||
      slugify(payload.title || "article", { lower: true, strict: true }) ||
      `article-${Date.now()}`;

    payload.status = (payload.status || "draft").toLowerCase();
    syncCategorySlug(payload);

    if (!payload.tags || payload.tags.length === 0) {
      payload.tags = extractTags(
        { title: payload.title, summary: payload.summary, body: payload.body },
        8
      );
    }

    // ✅ SINGLE SOURCE OF TRUTH FOR IMAGES:
    // finalizeArticleImages will:
    // - keep manual imageUrl
    // - upload drive link if provided manually
    // - auto-pick from Cloudinary if nothing is provided
    // - store reason in autoImageDebug
    const finalized = await finalizeArticleImages(payload);

    payload.imagePublicId = finalized.imagePublicId;
    payload.imageUrl = finalized.imageUrl;
    payload.ogImage = finalized.ogImage;
    payload.thumbImage = finalized.thumbImage;
    payload.imageAlt = finalized.imageAlt;

    // ✅ these explain "why" and whether it was auto-picked
    payload.autoImageDebug = finalized.autoImageDebug || payload.autoImageDebug || null;
    payload.autoImagePicked =
      typeof finalized.autoImagePicked === "boolean" ? finalized.autoImagePicked : payload.autoImagePicked;
    payload.autoImagePickedAt = finalized.autoImagePickedAt || payload.autoImagePickedAt || null;

    // extra safety (variants)
    finalizeImageFields(payload);

    const doc = await Article.create(payload);
    res.status(201).json(doc.toObject());
  } catch (err) {
    res.status(500).json({ error: String(err.message) });
  }
};

// ---------------------------------------------------------
// UPDATE ARTICLE
// ---------------------------------------------------------
exports.update = async (req, res) => {
  try {
    const doc = await Article.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "not_found" });

    Object.assign(doc, normalizeEmptyImages(req.body));
    syncCategorySlug(doc);

    // ✅ SINGLE SOURCE OF TRUTH FOR IMAGES (same as create)
    const finalized = await finalizeArticleImages(doc);

    doc.imagePublicId = finalized.imagePublicId;
    doc.imageUrl = finalized.imageUrl;
    doc.ogImage = finalized.ogImage;
    doc.thumbImage = finalized.thumbImage;
    doc.imageAlt = finalized.imageAlt;

    doc.autoImageDebug = finalized.autoImageDebug || doc.autoImageDebug || null;
    doc.autoImagePicked =
      typeof finalized.autoImagePicked === "boolean" ? finalized.autoImagePicked : doc.autoImagePicked;
    doc.autoImagePickedAt = finalized.autoImagePickedAt || doc.autoImagePickedAt || null;

    // extra safety (variants)
    finalizeImageFields(doc);

    await doc.save();
    res.json(doc.toObject());
  } catch (err) {
    res.status(500).json({ error: String(err.message) });
  }
};
