// models/FeedSource.js
const mongoose = require('mongoose');

const FeedSourceSchema = new mongoose.Schema({
  name: { type: String, required: true },
  url:  { type: String, required: true, unique: true },
  enabled: { type: Boolean, default: true },
  defaultCategory: { type: String, default: 'General' },
  defaultAuthor: { type: String, default: 'Desk' },
  geo: {
    mode: { type: String, default: 'Global' }, // Global | Regional
    areas: [{ type: String }],
  },
  schedule: { type: String, default: 'manual' }, // manual | 30m | hourly | daily
}, { timestamps: true });

module.exports = mongoose.model('FeedSource', FeedSourceSchema);
