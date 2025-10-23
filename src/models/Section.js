// backend/src/models/Section.js
const { Schema, model } = require("mongoose");

/* ------------------------------------------------------------------
 * Capacity maps (defaults + max). Keep in sync with routes/admin.
 * ------------------------------------------------------------------ */
const DEFAULT_CAP = {
  // Rails
  rail_v3: 5,   // ✅ default 5 items as requested
  rail_v4: 4,
  rail_v5: 8,
  rail_v6: 6,   // lead + up to 5 rows
  rail_v7: 1,   // single promo/image rail
  rail_filmybazaar_v1: 8, // ✅ added
  rail_filmybazaar_v2: 8,
  rail_filmybazaar_v3: 8, 
  rail_filmybazaar_v4: 4, 
  rail_sports_v1: 8, 
  sports_v2: 6,
  sports_v3: 8, 
   tech_main_v1: 9,  // 👈 1 feature + 2 mids + 6 list


  // Main sections
  main_v1: 12,
  main_v2: 12,
  main_v3: 12,
  main_v4: 12,
  main_v5: 6,
  main_v6: 12,
  main_v7: 7,   // preserved from your setup
  main_v8: 7,   // preserved from your setup
  main_v9 :8,
  m10 :2,

  // Heads / others
  head_v1: 12,
  head_v2: 6,
  grid_v1: 9,
  carousel_v1: 12,
  list_v1: 24,
  hero_v1: 1,
  feature_v1: 1,
  feature_v2: 2,
  mega_v1: 5,
  breaking_v1: 5,
  dark_v1: 5,
  rail_v8: 1,

  // NEW: composite top section
  top_v1: 20,
  top_v2: 20,
};

const MAX_CAP = {
  // Rails
  rail_v3: 30,
  rail_v4: 8,
  rail_v5: 24,
  rail_v6: 12,
  rail_v7: 1,   // fixed single
  rail_filmybazaar_v1: 12, // ✅ added
  rail_filmybazaar_v2: 12,
  rail_filmybazaar_v3: 12,
  rail_filmybazaar_v4: 8,
  rail_sports_v1: 12, 
  sports_v2: 6,
  sports_v3: 12,
  tech_main_v1: 12, // 👈 let editors bump as needed

  // Main sections
  main_v1: 24,
  main_v2: 20,
  main_v3: 20,
  main_v4: 24,
  main_v5: 12,
  main_v6: 24,
  main_v7: 12,
  main_v8: 12,
  main_v9 : 8,
  m10 :2, 

  // Heads / others
  head_v1: 24,
  head_v2: 12,
  grid_v1: 24,
  carousel_v1: 24,
  list_v1: 36,
  hero_v1: 1,
  feature_v1: 6,
  feature_v2: 6,
  mega_v1: 8,
  breaking_v1: 8,
  dark_v1: 8,

  // NEW: composite top section
  top_v1: 50,
  top_v2: 50,
};

/* ------------------------------------------------------------------
 * Pin schema (for manual pins)
 * ------------------------------------------------------------------ */
const PinSchema = new Schema(
  {
    articleId: { type: Schema.Types.ObjectId, ref: "Article", required: true },
    startAt: { type: Date },
    endAt: { type: Date },
  },
  { _id: false }
);

/* ------------------------------------------------------------------
 * Section schema
 * ------------------------------------------------------------------ */
const SectionSchema = new Schema(
  {
    title: { type: String, required: true },
    slug: { type: String, required: true, unique: true, index: true },

    template: { type: String, required: true },

    /**
     * Which column to render into (for rails).
     * Empty string is fine for main/center sections.
     */
    side: { type: String, enum: ["", "left", "right"], default: "" },

    /**
     * Arbitrary config for templates (JSON).
     * - rail_v7 still works (imageUrl/alt/linkUrl/aspect)
     * - top_v1 uses nested zone queries under custom.*
     */
    custom: { type: Schema.Types.Mixed, default: {} },

    capacity: {
      type: Number,
      min: 1,
      default: function () {
        return DEFAULT_CAP[this.template] ?? 6;
      },
      validate: {
        validator: function (v) {
          const max = MAX_CAP[this.template] ?? 24;
          return v >= 1 && v <= max;
        },
        message: (props) =>
          `Capacity ${props.value} exceeds max for template "${props.instance?.template}"`,
      },
    },

    target: {
      type: {
        type: String,
        enum: ["homepage", "path", "category"],
        required: true,
      },
      value: { type: String, required: true },
    },

    feed: {
      mode: { type: String, enum: ["auto", "manual", "mixed"], default: "auto" },
      categories: [{ type: String }], // store slugs/ids as strings
      tags: [{ type: String }],
      sortBy: { type: String, enum: ["publishedAt", "priority"], default: "publishedAt" },
      timeWindowHours: { type: Number, default: 0 },
      // Slice controls (1-based)
    sliceFrom: { type: Number, default: 1 },
    sliceTo:   { type: Number },

    },

    pins: [PinSchema],

    moreLink: { type: String, default: "" },
    enabled: { type: Boolean, default: true },
    placementIndex: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/* ------------------------------------------------------------------
 * Index used by the plan query
 * ------------------------------------------------------------------ */
SectionSchema.index({
  enabled: 1,
  "target.type": 1,
  "target.value": 1,
  placementIndex: 1,
});

module.exports = model("Section", SectionSchema);
module.exports.DEFAULT_CAP = DEFAULT_CAP;
module.exports.MAX_CAP = MAX_CAP;
