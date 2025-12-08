// backend/src/models/Article.js
const mongoose = require('mongoose');

/**
 * ---- Content quality thresholds (tweak via env if you like) ----
 * ARTICLE_MIN_BODY:    minimum words required in body (default 350)
 * ARTICLE_MIN_SUMMARY: minimum characters required in summary (default 60)
 * ARTICLE_ENFORCE_MIN: "true" enables strict validation on publish
 */
const MIN_BODY = parseInt(process.env.ARTICLE_MIN_BODY || '350', 10);
const MIN_SUMMARY = parseInt(process.env.ARTICLE_MIN_SUMMARY || '60', 10);

// Phase 10: disabled by default — articles WILL NOT fail validation
const ENFORCE_MIN_ON_PUBLISH =
  String(process.env.ARTICLE_ENFORCE_MIN || "").toLowerCase() === "true";

function stripHtml(s = '') {
  return String(s).replace(/<[^>]*>/g, ' ');
}
function wordCount(s = '') {
  return stripHtml(s).trim().split(/\s+/).filter(Boolean).length;
}
function calcReadingTime(body = '') {
  return Math.max(1, Math.round(wordCount(body) / 200));
}

const ArticleSchema = new mongoose.Schema({
  title:       { type: String, required: true, trim: true },
  slug:        { type: String, required: true, unique: true, index: true },

  summary:     { type: String, default: '' },
  author:      { type: String, default: '' },

  // Main content
  body:        { type: String, default: '' },
  bodyHtml:    { type: String, default: '' },

  // Taxonomy
  category:    { type: String, index: true },
  tags:        { type: [String], default: [], index: true },

  // Timeline
  year:       { type: Number, min: 0, max: 4000 },
  era:        { type: String, enum: ['BC', 'AD'], default: 'BC' },

  // Images
  imageUrl:      { type: String, default: '' },
  imagePublicId: { type: String, default: '' },
  imageAlt:      { type: String, default: '' },
  ogImage:       { type: String, default: '' },
  thumbImage:    { type: String, default: '' },

  // SEO
  metaTitle:   { type: String, default: '' },
  metaDesc:    { type: String, default: '' },

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
  publishAt:   { type: Date },
  publishedAt: { type: Date, index: true },

  // Provenance
  source:      { type: String, default: 'automation' },
  sourceUrl:   { type: String, default: '' },

  // Optional geo targeting
  geoMode:   { type: String, enum: ['global','include','exclude'], default: 'global' },
  geoAreas:  { type: [String], default: [] },

}, { timestamps: true });

/**
 * ---- Validation + enrichment ----
 * Phase 10:
 *  NO MIN BODY or MIN SUMMARY ENFORCEMENT unless ARTICLE_ENFORCE_MIN="true"
 */
ArticleSchema.pre('validate', function(next) {
  if (ENFORCE_MIN_ON_PUBLISH && this.status === 'published') {
    const text = this.body && this.body.trim().length ? this.body : this.bodyHtml;
    const sumLen = stripHtml(this.summary).trim().length;
    const bodyWords = wordCount(text);

    if (sumLen < MIN_SUMMARY) {
      return next(new Error(`Summary too short: need at least ${MIN_SUMMARY} characters.`));
    }
    if (bodyWords < MIN_BODY) {
      return next(new Error(`Body too short: need at least ${MIN_BODY} words, got ${bodyWords}.`));
    }
  }

  return next();
});

/**
 * Enrich document before saving
 */
ArticleSchema.pre('save', function(next) {
  const text = this.body && this.body.trim().length ? this.body : this.bodyHtml;

  // Reading time
  this.readingTime = calcReadingTime(text || '');

  // SEO defaults
  if (!this.metaTitle || !this.metaTitle.trim()) {
    this.metaTitle = String(this.title || '').slice(0, 70);
  }
  if (!this.metaDesc || !this.metaDesc.trim()) {
    const base = this.summary?.trim().length
      ? this.summary
      : stripHtml(text || '');
    this.metaDesc = String(base).slice(0, 160);
  }

  // Auto publishedAt timestamp
  if (this.isModified('status') && this.status === 'published' && !this.publishedAt) {
    this.publishedAt = new Date();
  }

  next();
});

// Helpful indexes
ArticleSchema.index({ status: 1, publishedAt: -1 });
ArticleSchema.index({ category: 1, publishedAt: -1 });
ArticleSchema.index({ tags: 1, publishedAt: -1 });
ArticleSchema.index({ publishedAt: -1 });
ArticleSchema.index({ slug: 1 }, { unique: true });
ArticleSchema.index({ category: 1, year: 1 });

module.exports = mongoose.models.Article || mongoose.model('Article', ArticleSchema);
