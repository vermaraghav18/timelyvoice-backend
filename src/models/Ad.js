// backend/src/models/Ad.js
const { Schema, model } = require("mongoose");

// backend/src/models/Ad.js
const AdSchema = new Schema({
  imageUrl: { type: String, required: true },
  linkUrl:  { type: String, required: true },

  target: {
    type: {
      type: String,
      enum: ["homepage", "category", "path"],
      required: true,
    },
    value: { type: String, default: "" },
  },

  // lower index renders earlier
  placementIndex: { type: Number, default: 0 },

  // ✅ NEW
  custom: {
    afterNth: { type: Number }, // when set, FE treats this as an inset after N articles
  },

  enabled: { type: Boolean, default: true },
  notes:   { type: String, default: "" },
}, { timestamps: true });

AdSchema.index({ "target.type": 1, "target.value": 1, placementIndex: 1 });

module.exports = model("Ad", AdSchema);
