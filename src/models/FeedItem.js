// models/FeedItem.js
const mongoose = require('mongoose');

const FeedItemSchema = new mongoose.Schema({
  feedId: { type: mongoose.Schema.Types.ObjectId, ref: 'FeedSource', required: true },
  sourceName: String,

  link: { type: String, index: true },
  guid: { type: String, index: true },
  publishedAt: Date,

  rawTitle: String,
  rawSummary: String,

  status: {
    type: String,
    enum: ['fetched', 'extr', 'gen', 'ready', 'skipped', 'drafted'],
    default: 'fetched'
  },

  extract: {
    html: String,
    text: String,
    author: String,
    site: String,
    language: String,
  },

  generated: {
    title: String,
    slug: String,
    summary: String,
    author: String,
    category: String,
    status: String,
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
    body: String,
  },

  articleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Article' },
  error: String,
}, { timestamps: true });

FeedItemSchema.index({ link: 1 }, { unique: false });
FeedItemSchema.index({ guid: 1 }, { unique: false });

module.exports = mongoose.model('FeedItem', FeedItemSchema);
