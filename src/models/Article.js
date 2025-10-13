const mongoose = require('mongoose');

const ArticleSchema = new mongoose.Schema({
  title:       { type: String, required: true, trim: true },
  slug:        { type: String, required: true, unique: true, index: true },
  summary:     { type: String, default: '' },
  author:      { type: String, default: '' },

  // Main content
  body:        { type: String, default: '' },        // raw / markdown / html (your choice)
  bodyHtml:    { type: String, default: '' },        // optional: rendered HTML if you keep both

  // Taxonomy
  category:    { type: String, index: true },
  tags:        { type: [String], default: [], index: true },

  // Images
  imageUrl:      { type: String, default: '' },      // Cloudinary URL or any absolute URL
  imagePublicId: { type: String, default: '' },
  imageAlt:      { type: String, default: '' },

  // SEO / Social
  metaTitle:   { type: String, default: '' },
  metaDesc:    { type: String, default: '' },
  ogImage:     { type: String, default: '' },

  // Other
  readingTime: { type: Number, default: 0 },

  // Publishing
  publishAt:   { type: Date },
  publishedAt: { type: Date, default: Date.now, index: true },

  // Optional geo targeting (if you use it elsewhere)
  geoMode:   { type: String, enum: ['global', 'category', 'state', 'city', 'none'], default: 'none' },
  geoAreas:  { type: [String], default: [] },
}, { timestamps: true });

// Fast lists by category/tag sorted by newest first
ArticleSchema.index({ category: 1, publishedAt: -1 });
ArticleSchema.index({ tags: 1, publishedAt: -1 });

// General newest-first listing
ArticleSchema.index({ publishedAt: -1 });

// For slug lookup (if not already unique)
ArticleSchema.index({ slug: 1 }, { unique: true });


module.exports = mongoose.models.Article || mongoose.model('Article', ArticleSchema);
