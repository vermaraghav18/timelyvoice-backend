// backend/src/models/RssTopicFingerprint.js
// Stores "seen topics" so the cron can skip duplicate AI articles.

const mongoose = require("mongoose");

const rssTopicFingerprintSchema = new mongoose.Schema(
  {
    topicKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    firstSeenAt: {
      type: Date,
      default: Date.now,
      // Auto-delete after 7 days so collection doesn't grow forever
      expires: 7 * 24 * 60 * 60, // 7 days in seconds
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },
    latestTitle: {
      type: String,
    },
    latestLink: {
      type: String,
    },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.RssTopicFingerprint ||
  mongoose.model("RssTopicFingerprint", rssTopicFingerprintSchema);
