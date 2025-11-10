// backend/src/models/XSource.js
"use strict";

const mongoose = require("mongoose");

const XSourceSchema = new mongoose.Schema(
  {
    handle: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
      unique: true,
    },
    label: { type: String, default: "" },
    enabled: { type: Boolean, default: true },
    defaultAuthor: { type: String, default: "Desk" },
    defaultCategory: { type: String, default: "General" },
  },
  { timestamps: true }
);

// normalize handle: remove leading @
XSourceSchema.pre("validate", function (next) {
  if (this.handle) this.handle = String(this.handle).replace(/^@/, "").trim().toLowerCase();
  next();
});

module.exports = mongoose.model("XSource", XSourceSchema);
