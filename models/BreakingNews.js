// backend/models/BreakingNews.js
const mongoose = require('mongoose');

const BreakingNewsSchema = new mongoose.Schema(
  {
    headline: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
    },
    url: {
      type: String,
      default: '',
      trim: true,
    },
    active: {
      type: Boolean,
      default: true,
      index: true,
    },
    priority: {
      // lower number = shown first
      type: Number,
      default: 0,
      index: true,
    },
  },
  {
    timestamps: true, // createdAt, updatedAt
    versionKey: false,
  }
);

// helpful compound index for listing
BreakingNewsSchema.index({ active: 1, priority: 1, createdAt: -1 });

module.exports = mongoose.model('BreakingNews', BreakingNewsSchema);
