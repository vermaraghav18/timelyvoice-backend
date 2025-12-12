// backend/src/models/RssTopicFingerprint.js
const mongoose = require("mongoose");

const RssTopicFingerprintSchema = new mongoose.Schema(
  {
    // Normalized topic key like: "box office dhurandhar"
    key: { type: String, required: true, index: true },

    // Optional category ("Sports", "World", etc.)
    category: { type: String, index: true },

    // When we first saw this topic in RSS
    firstSeenAt: { type: Date, default: Date.now },

    // When we last saw a seed/article for this topic
    lastSeenAt: { type: Date, default: Date.now },

    // How many RSS seeds we have seen for this topic
    seedCount: { type: Number, default: 0 },

    // How many AI articles we actually generated for this topic
    articleCount: { type: Number, default: 0 },

    // Optional: which Article documents were generated
    articleIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Article",
      },
    ],
  },
  {
    timestamps: true,
  }
);

RssTopicFingerprintSchema.index({ key: 1, category: 1 }, { unique: true });

module.exports = mongoose.model(
  "RssTopicFingerprint",
  RssTopicFingerprintSchema
);
