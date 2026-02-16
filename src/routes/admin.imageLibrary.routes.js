// backend/src/routes/admin.imageLibrary.routes.js
const express = require("express");
const multer = require("multer");

const router = express.Router();

const {
  createImage,
  resolvePublicId,
  listImages,
  updateImage,
  deleteImage,
} = require("../controllers/admin.imageLibrary.controller");


// ✅ Multer memory storage (no disk writes)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    // 10MB max (safe for admin uploads)
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const mime = (file && file.mimetype) || "";
    if (!mime.startsWith("image/")) {
      return cb(new Error("Only image files are allowed"));
    }
    cb(null, true);
  },
});

// POST: upload image file + save metadata (Cloudinary + MongoDB)
router.post("/", upload.single("file"), createImage);

// GET: resolve publicId -> url (must be BEFORE "/:id")
router.get("/resolve", resolvePublicId);

// GET: list/search images
router.get("/", listImages);


// PATCH: edit tags/category/priority
router.patch("/:id", updateImage);

// DELETE: remove from DB; optional Cloudinary delete via ?deleteFromCloudinary=true
router.delete("/:id", deleteImage);

module.exports = router;
