// backend/src/models/PageSectionV2.js
const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  title: { type: String, default: "" },
  type: { type: String, required: true },         // e.g. 'rail_promo_square_v1'
  side: { type: String, enum: ["left", "right"], default: "right" },
  order: { type: Number, default: 0 },
  enabled: { type: Boolean, default: true },
  source: { type: Object, default: null },        // { type: 'manual' } or { type: 'query' }
  query: { type: Object, default: {} },
  config: { type: Object, default: {} },
  ui: { type: Object, default: {} },
  items: { type: Array, default: [] },            // manual items
}, { timestamps: true });
module.exports = mongoose.model("PageSectionV2", schema);
