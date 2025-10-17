// backend/src/models/XItem.js
"use strict";
const mongoose = require("mongoose");

const XItemSchema = new mongoose.Schema(
  {
    xId: { type: String, required: true, index: true }, // tweet id
    handle: { type: String, required: true, index: true }, // e.g. "MEAIndia"
    tweetedAt: { type: Date, index: true },

    text: { type: String, default: "" },
    html: { type: String, default: "" },

    media: [{ type: { type: String }, url: String }], // optional
    urls: { type: [String], default: [] },            // expanded URLs in tweet (if any)

    status: {
      type: String,
      enum: ["new", "extracted", "generated", "ready", "drafted", "skipped"],
      default: "new",
      index: true,
    },

    extract: {
      text: String,
      html: String,
      sources: [
        {
          url: String,
          score: Number,
          why: String,
          title: String,
          publishedAt: Date,
        },
      ],
    },

    generated: { type: Object, default: null }, // your JSON draft
    articleId: { type: mongoose.Schema.Types.ObjectId, ref: "Article" },

    error: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("XItem", XItemSchema);
