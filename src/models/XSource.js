// backend/src/models/XSource.js
"use strict";
const mongoose = require("mongoose");

const XSourceSchema = new mongoose.Schema(
  {
    handle: { type: String, required: true, index: true }, // e.g. "MEAIndia" (without @)
    label: { type: String, default: "" },
    enabled: { type: Boolean, default: true },
    defaultAuthor: { type: String, default: "Desk" },
    defaultCategory: { type: String, default: "Politics" },
    geo: {
      mode: { type: String, enum: ["Global", "India", "Targeted"], default: "Global" },
      areas: { type: [String], default: [] },
    },
    schedule: { type: String, default: "" }, // optional cron text; not strictly needed now
    sinceId: { type: String, default: "" },  // last seen tweet id
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("XSource", XSourceSchema);
