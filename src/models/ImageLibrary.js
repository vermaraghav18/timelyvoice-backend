// backend/src/models/ImageLibrary.js
const mongoose = require("mongoose");

const ImageLibrarySchema = new mongoose.Schema(
  {
    publicId: { type: String, required: true, index: true }, // Cloudinary public_id
    url: { type: String, required: true }, // Cloudinary secure_url

    // Our trusted tags (NOT Cloudinary tags)
    tags: { type: [String], default: [], index: true },

    category: { type: String, default: "" }, // optional: World/India/Business
    source: {
      type: String,
      enum: ["manual", "ai", "google"],
      default: "manual",
      index: true,
    },

    // higher priority wins when same tag matches
    priority: { type: Number, default: 0, index: true },
  },
  { timestamps: true }
);

// Avoid duplicate entries for the same Cloudinary asset
ImageLibrarySchema.index({ publicId: 1 }, { unique: true });

module.exports = mongoose.model("ImageLibrary", ImageLibrarySchema);
