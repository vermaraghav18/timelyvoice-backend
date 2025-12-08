// backend/src/models/RssTopicFingerprint.js
const mongoose = require("mongoose");

const RssTopicFingerprintSchema = new mongoose.Schema(
  {
    topicKey: {
      type: String,
      required: true,
      unique: true,
    },
    latestTitle: String,
    latestLink: String,
    sourceIds: [String], // optional: which RSS feeds have this story
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Unique topic key
RssTopicFingerprintSchema.index({ topicKey: 1 }, { unique: true });

// Auto-expire after 48 hours (so topics can re-appear after 2 days)
RssTopicFingerprintSchema.index(
  { lastSeenAt: 1 },
  { expireAfterSeconds: 48 * 3600 }
);

module.exports = mongoose.model(
  "RssTopicFingerprint",
  RssTopicFingerprintSchema
);
