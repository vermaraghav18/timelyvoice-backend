// backend/src/models/FeedSource.js
const mongoose = require('mongoose');

const FeedSourceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    // NOTE: remove inline unique:true (safer to define the index below with a partial filter)
    url: { type: String, required: true },

    enabled: { type: Boolean, default: true },

    defaultCategory: { type: String, default: 'General' },
    defaultAuthor:   { type: String, default: 'Desk' },

    geo: {
      // keep consistent with controller usage (usually lowercased)
      mode:  { type: String, default: 'global' }, // 'global' | 'regional'
      areas: [{ type: String }],
    },

    // for future scheduling (manual | 30m | hourly | daily)
    schedule: { type: String, default: 'manual' },
  },
  { timestamps: true }
);

// Prevent duplicate feeds by URL, but don't block null/undefined.
// This is safer than `unique:true` on the path.
FeedSourceSchema.index(
  { url: 1 },
  { unique: true, partialFilterExpression: { url: { $type: 'string' } } }
);

module.exports = mongoose.model('FeedSource', FeedSourceSchema);
