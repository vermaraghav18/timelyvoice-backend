// backend/models/AnalyticsEvent.js
const mongoose = require('mongoose');

const AnalyticsEventSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      enum: ['page_view', 'scroll', 'heartbeat', 'read_complete'],
    },
    ts: { type: Date, required: true }, // client timestamp

    visitorId: String,
    sessionId: String,
    path: String,
    utm: mongoose.Schema.Types.Mixed,
    referrer: String,
    scroll: mongoose.Schema.Types.Mixed, // e.g. { p25:true, p50:true, p75:false, p90:false }
    read: mongoose.Schema.Types.Mixed,   // e.g. { seconds: 42, complete: false }

    // --- server enrichment ---
    geo: mongoose.Schema.Types.Mixed,    // full object from geo middleware
    device: mongoose.Schema.Types.Mixed, // UA parser result if any
    flags: {
      isBot: { type: Boolean, default: false },
      isAdmin: { type: Boolean, default: false },
      dnt: { type: Boolean, default: false },
      optOut: { type: Boolean, default: false },
    },

    // --- NEW: flattened fields used by rollups ---
    ip: String,
    country: String, // 2-letter code like "US", "IN"
    region: String,  // provider-specific region code
    city: String,
  },
  {
    timestamps: true,               // adds createdAt/updatedAt
    collection: 'analyticsevents',  // force consistent collection name
  }
);

// helpful indexes
AnalyticsEventSchema.index({ createdAt: -1 });
AnalyticsEventSchema.index({ type: 1, createdAt: -1 });

// NEW: optional index to speed country aggregations
AnalyticsEventSchema.index({ country: 1, type: 1, createdAt: -1 });

module.exports = mongoose.model('AnalyticsEvent', AnalyticsEventSchema);
