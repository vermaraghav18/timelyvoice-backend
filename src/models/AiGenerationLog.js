// backend/src/models/AiGenerationLog.js
const mongoose = require("mongoose");

const AiGenerationLogSchema = new mongoose.Schema(
  {
    runAt: { type: Date, default: Date.now },

    model: { type: String }, // e.g. "openai/gpt-4o-mini"

    countRequested: { type: Number }, // what we asked for (e.g. 10)
    countGenerated: { type: Number }, // how many AI articles we got back
    countSaved: { type: Number },     // how many were actually saved to DB

    status: {
      type: String,
      enum: ["success", "partial", "error"],
      default: "success",
    },

    errorMessage: { type: String },

    durationMs: { type: Number }, // how long the batch took

    // e.g. "draft" or "published" for this batch
    requestStatus: { type: String },

    // optional: categories we asked for
    categories: [{ type: String }],

    // Quick snapshot of created articles
    samples: [
      {
        articleId: { type: mongoose.Schema.Types.ObjectId, ref: "Article" },
        slug: String,
        title: String,
        status: String,
        publishAt: Date,
      },
    ],

    // For the future if you want to know whether this came from cron, UI, etc.
    triggeredBy: {
      type: String,
      default: "api-admin-ai-generate-batch",
    },
  },
  {
    timestamps: true,
  }
);

AiGenerationLogSchema.index({ runAt: -1 });

module.exports =
  mongoose.models.AiGenerationLog ||
  mongoose.model("AiGenerationLog", AiGenerationLogSchema);
