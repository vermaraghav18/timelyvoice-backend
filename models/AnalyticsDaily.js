const mongoose = require('mongoose');

const TotalsSchema = new mongoose.Schema({
  events: { type: Number, default: 0 },
  page_view: { type: Number, default: 0 },
  scroll: { type: Number, default: 0 },
  heartbeat: { type: Number, default: 0 },
  read_complete: { type: Number, default: 0 },
  uniqueVisitors: { type: Number, default: 0 },
}, { _id: false });

const ByPathSchema = new mongoose.Schema({
  path: String,
  events: { type: Number, default: 0 },
  page_view: { type: Number, default: 0 },
  scroll: { type: Number, default: 0 },
  heartbeat: { type: Number, default: 0 },
  read_complete: { type: Number, default: 0 },
  uniques: { type: Number, default: 0 },
  readSeconds: { type: Number, default: 0 },
}, { _id: false });

// Already added earlier
const TopUTMSchema = new mongoose.Schema({
  source: { type: String, default: null },
  medium: { type: String, default: null },
  campaign: { type: String, default: null },
  page_view: { type: Number, default: 0 },
  read_complete: { type: Number, default: 0 },
  uniques: { type: Number, default: 0 },
}, { _id: false });

// NEW: Top countries (by ISO country code or name if you send it)
const TopCountrySchema = new mongoose.Schema({
  country: { type: String, default: null }, // e.g. "IN", "US"
  page_view: { type: Number, default: 0 },
  uniques: { type: Number, default: 0 },
}, { _id: false });

const AnalyticsDailySchema = new mongoose.Schema({
  date: { type: String, required: true, unique: true }, // 'YYYY-MM-DD' (UTC)
  totals: { type: TotalsSchema, default: () => ({}) },
  byPath: { type: [ByPathSchema], default: [] },
  generatedAt: { type: Date, default: Date.now },

  // Slices
  topUTMs: { type: [TopUTMSchema], default: [] },
  topCountries: { type: [TopCountrySchema], default: [] }, // NEW
}, {
  timestamps: true,
  collection: 'analyticsdaily',
});

AnalyticsDailySchema.index({ date: 1 }, { unique: true });

module.exports = mongoose.model('AnalyticsDaily', AnalyticsDailySchema);
