// models/FeedItem.js
const mongoose = require('mongoose');

const FeedItemSchema = new mongoose.Schema(
  {
    feedId: { type: mongoose.Schema.Types.ObjectId, ref: 'FeedSource', required: true },
    sourceName: String,

    link: { type: String, index: true },
    guid: { type: String, index: true },
    publishedAt: Date,

    rawTitle: String,
    rawSummary: String,

    // Expanded to include "failed" to track generation/extraction errors
    status: {
      type: String,
      enum: ['fetched', 'extr', 'gen', 'ready', 'skipped', 'drafted', 'failed'],
      default: 'fetched',
    },

    extract: {
      html: String,
      text: String,
      author: String,
      site: String,
      language: String, // detected language from extractor (if any)
    },

    generated: {
      // Existing fields (kept for compatibility with your pipeline)
      title: String,
      slug: String,
      summary: String,          // legacy/general summary
      author: String,
      category: String,
      status: String,           // internal status for generated draft
      publishAt: String,
      imageUrl: String,
      imagePublicId: String,
      seo: {
        imageAlt: String,
        metaTitle: String,
        metaDescription: String,
        ogImageUrl: String,
      },
      geo: {
        mode: String,
        areas: [String],
      },
      tags: [String],
      body: String,             // legacy/general body

      // New fields for the rewrite spec
      language: String,         // language used for the generated text (same as source)
      summary90: String,        // ~90-word summary (fresh wording)
      body300: String,          // ~300-word body (fresh wording)

      // Provenance / accounting
      model: String,            // e.g. 'anthropic/claude-3.5-sonnet:beta'
      tokens: {
        prompt: { type: Number, default: 0 },
        completion: { type: Number, default: 0 },
        total: { type: Number, default: 0 },
      },
      costUSD: { type: Number, default: 0 },
      at: Date,                 // when generation happened
    },

    articleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Article' },
    error: String,              // store last error message if any
  },
  { timestamps: true }
);

// indexes
FeedItemSchema.index({ link: 1 }, { unique: false });
FeedItemSchema.index({ guid: 1 }, { unique: false });

module.exports = mongoose.model('FeedItem', FeedItemSchema);
