// backend/src/models/Article.js
const mongoose = require('mongoose');

/**
 * ---- Content quality thresholds (tweak via env if you like) ----
 * ARTICLE_MIN_BODY:    minimum words required in body (default 350)
 * ARTICLE_MIN_SUMMARY: minimum characters required in summary (default 60)
 */
const MIN_BODY = parseInt(process.env.ARTICLE_MIN_BODY || '350', 10);
const MIN_SUMMARY = parseInt(process.env.ARTICLE_MIN_SUMMARY || '60', 10);

function stripHtml(s = '') {
  return String(s).replace(/<[^>]*>/g, ' ');
}
function wordCount(s = '') {
  return stripHtml(s).trim().split(/\s+/).filter(Boolean).length;
}
function calcReadingTime(body = '') {
  // 200 wpm baseline
  return Math.max(1, Math.round(wordCount(body) / 200));
}

const ArticleSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  slug:  { type: String, required: true, unique: true, index: true },

  summary: { type: String, default: '' },
  author:  { type: String, default: '' },

  // Main content
  body:     { type: String, default: '' }, // raw / markdown / html
  bodyHtml: { type: String, default: '' }, // if you keep both

  // Taxonomy
  category:     { type: String, index: true },     // display name (e.g., "Business")
  categorySlug: { type: String, index: true },     // canonical key (e.g., "business")
  tags:         { type: [String], default: [], index: true },

  // Homepage placement (controls which homepage bucket this article belongs to)
  homepagePlacement: {
    type: String,
    enum: ['none', 'top', 'latest', 'trending'],
    default: 'none',
    index: true,
    lowercase: true,
    trim: true,
  },

  // Timeline (used for History)
  year: { type: Number, min: 0, max: 4000 }, // 0–4000 (we treat as BC for now)
  era:  { type: String, enum: ['BC', 'AD'], default: 'BC' },

  // Images
  imageUrl:      { type: String, default: '' }, // Cloudinary (or absolute) URL
  imagePublicId: { type: String, default: '' },
  sourceImageUrl: { type: String, default: "" },
sourceImageFrom: { type: String, default: "" },

  imageAlt:      { type: String, default: '' },
  ogImage:       { type: String, default: '' }, // social (1200x630)
  thumbImage:    { type: String, default: '' }, // list/grid thumbnails

  // NEW: optional video URL (Google Drive, Cloudinary, etc.)
  videoUrl: { type: String, default: null },

  // SEO
  metaTitle: { type: String, default: '' },
  metaDesc:  { type: String, default: '' },

  // keep Cloudinary public_id + original source (Drive)
  videoPublicId:  { type: String, default: '' },
  videoSourceUrl: { type: String, default: '' },

  // Other
  readingTime: { type: Number, default: 0 },

  // Publishing
  status: {
    type: String,
    enum: ['draft', 'published'],
    default: 'draft',
    index: true,
    lowercase: true,
    trim: true
  },
  publishAt:   { type: Date },              // schedule time
  publishedAt: { type: Date, index: true }, // set when actually publishing

  // Provenance
  source:    { type: String, default: 'automation' },
  sourceUrl: { type: String, default: '' },
  sourceUrlCanonical: { type: String, index: true },

  // Optional geo targeting
  geoMode:  { type: String, enum: ['global', 'include', 'exclude'], default: 'global' },
  geoAreas: { type: [String], default: [] },

  /**
   * ✅ AUTO IMAGE DEBUG
   * Your controllers/services can write: payload.autoImageDebug = {...}
   * Mongoose stores it as "_autoImageDebug"
   *
   * Improvement:
   * - alias: autoImageDebug (existing)
   * - we ALSO treat it as "autoImageWhy" (same data) for convenience
   */
  _autoImageDebug: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
    alias: 'autoImageDebug',
  },

  // ✅ Optional helpers for Admin UI
  autoImagePicked:   { type: Boolean, default: false },
  autoImagePickedAt: { type: Date, default: null },

}, { timestamps: true });

/**
 * ---- Validation + enrichment ----
 * Enforce min summary/body only when publishing; derive readingTime, metaTitle/metaDesc; set publishedAt on publish.
 */
ArticleSchema.pre('validate', function(next) {
  if (this.status === 'published') {
    const textForCount = this.body && this.body.trim().length ? this.body : this.bodyHtml;
    const sumLen = stripHtml(this.summary).trim().length;
    const bodyWords = wordCount(textForCount);

    if (sumLen < MIN_SUMMARY) {
      return next(new Error(`Summary too short: need at least ${MIN_SUMMARY} characters.`));
    }
    if (bodyWords < MIN_BODY) {
      return next(new Error(`Body too short: need at least ${MIN_BODY} words, got ${bodyWords}.`));
    }
  }
  return next();
});

ArticleSchema.pre('save', function(next) {
  const textForCount = this.body && this.body.trim().length ? this.body : this.bodyHtml;

  // Derive readingTime
  this.readingTime = calcReadingTime(textForCount || '');

  // Safe SEO defaults
  if (!this.metaTitle || !this.metaTitle.trim()) {
    this.metaTitle = String(this.title || '').slice(0, 70);
  }
  if (!this.metaDesc || !this.metaDesc.trim()) {
    const base = this.summary && this.summary.trim().length
      ? this.summary
      : stripHtml(textForCount || '');
    this.metaDesc = String(base).slice(0, 160);
  }

  // Ensure publishedAt when going live
  if (this.isModified('status') && this.status === 'published' && !this.publishedAt) {
    this.publishedAt = new Date();
  }

  next();
});

// Helpful indexes
ArticleSchema.index({ status: 1, publishedAt: -1 });
ArticleSchema.index({ category: 1, publishedAt: -1 });
ArticleSchema.index({ categorySlug: 1, publishedAt: -1 });
ArticleSchema.index({ tags: 1, publishedAt: -1 });
ArticleSchema.index({ publishedAt: -1 });
ArticleSchema.index({ slug: 1 }, { unique: true });
ArticleSchema.index({ category: 1, year: 1 });

module.exports = mongoose.models.Article || mongoose.model('Article', ArticleSchema);
