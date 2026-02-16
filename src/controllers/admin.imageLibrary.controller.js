// backend/src/controllers/admin.imageLibrary.controller.js
const ImageLibrary = require("../models/ImageLibrary");
const {
  uploadImageBuffer,
  deleteCloudinaryAsset,
} = require("../services/cloudinary.service");

// simple tag normalizer (matches your existing style)
function normalizeTag(raw = "") {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^#+/g, "")
    .replace(/[^a-z0-9_-]/g, "");
}

function normalizeTags(input) {
  // accepts: "iran, missile" OR ["iran","missile"]
  let arr = [];
  if (typeof input === "string") {
    arr = input.split(/[,|]/g);
  } else if (Array.isArray(input)) {
    arr = input;
  }
  const clean = arr.map(normalizeTag).filter(Boolean);
  return Array.from(new Set(clean)); // dedupe
}

function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * ✅ MULTI + SINGLE + LEGACY create
 *
 * Your route uses:
 * upload.fields([{name:"file"},{name:"files"}])
 * so the controller reads from req.files.file[] and req.files.files[].
 *
 * Also keeps legacy JSON mode (publicId/url) when no file(s) provided.
 */
exports.createImage = async (req, res) => {
  try {
    // ✅ multipart/form-data fields come in req.body
    const { tags, category = "", source = "manual", priority = 0 } = req.body || {};

    // ✅ legacy fields (old behavior)
    const { publicId, url } = req.body || {};

    // ✅ Collect all uploaded files (memoryStorage => buffers)
    const multi = Array.isArray(req?.files?.files) ? req.files.files : [];
    const single = Array.isArray(req?.files?.file) ? req.files.file : [];
    const allFiles = [...single, ...multi].filter(Boolean);

    // =========================
    // CASE 1: FILE(S) PROVIDED
    // =========================
    if (allFiles.length > 0) {
      const created = [];
      const failed = [];

      for (const f of allFiles) {
        try {
          if (!f?.buffer) {
            failed.push({
              name: f?.originalname || "unknown",
              error: "file buffer missing",
            });
            continue;
          }

          // Upload file buffer to Cloudinary
          const up = await uploadImageBuffer(f.buffer, {
            folder: process.env.CLOUDINARY_LIBRARY_FOLDER || "news-images/library",
          });

          const doc = await ImageLibrary.create({
            publicId: up.public_id,
            url: up.url,
            tags: normalizeTags(tags),
            category: String(category || "").trim(),
            source,
            priority: Number(priority) || 0,
          });

          created.push(doc);
        } catch (err) {
          // duplicate publicId
          if (err && err.code === 11000) {
            failed.push({
              name: f?.originalname || "unknown",
              error: "duplicate_publicId",
            });
            continue;
          }

          console.error("[ImageLibrary:createImage] per-file error:", err);
          failed.push({
            name: f?.originalname || "unknown",
            error: err?.message || "upload_failed",
          });
        }
      }

      if (created.length === 0) {
        const dupOnly =
          failed.length > 0 && failed.every((x) => x.error === "duplicate_publicId");
        return res.status(dupOnly ? 409 : 500).json({
          ok: false,
          error: dupOnly
            ? "All selected images already exist in Image Library (duplicate publicId)."
            : "Failed to upload images.",
          failed,
        });
      }

      // ✅ Backfill: safe behavior
      // - single upload => run your backfill
      // - batch upload => skip (avoid heavy scans N times)
      let backfill = null;
      if (created.length === 1) {
        try {
          const { backfillMatchingArticlesFromLibraryImage } = require("../services/imageBackfill");
          backfill = await backfillMatchingArticlesFromLibraryImage(created[0], {
            limit: 300,
            lookbackHours: 168, // last 7 days
            onlyAi: true,
          });
        } catch (e) {
          console.error("[ImageLibrary:createImage] backfill error:", e?.message || e);
          backfill = { ok: false, error: String(e?.message || e) };
        }
      } else {
        backfill = { ok: true, skipped: true, reason: "batch_upload" };
      }

      return res.json({
        ok: true,
        count: created.length,
        images: created, // ✅ array for multi
        image: created.length === 1 ? created[0] : undefined, // backward-friendly
        failed,
        backfill,
      });
    }

    // =========================
    // CASE 2: LEGACY JSON MODE
    // =========================
    if (!publicId) {
      return res.status(400).json({
        error: "file(s) is required (or provide publicId for legacy mode)",
      });
    }

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const cleanPublicId = String(publicId).trim();

    let finalLegacyUrl = url ? String(url).trim() : "";
    finalLegacyUrl = finalLegacyUrl.replace(/\s+/g, "");

    // If url is missing OR has placeholder, build from env
    if (!finalLegacyUrl || finalLegacyUrl.includes("YOUR_CLOUD_NAME")) {
      if (!cloudName) {
        return res.status(500).json({ error: "CLOUDINARY_CLOUD_NAME is missing in env" });
      }
      finalLegacyUrl = `https://res.cloudinary.com/${cloudName}/image/upload/v1/${cleanPublicId}.jpg`;
    }

    const doc = await ImageLibrary.create({
      publicId: cleanPublicId,
      url: finalLegacyUrl,
      tags: normalizeTags(tags),
      category: String(category || "").trim(),
      source,
      priority: Number(priority) || 0,
    });

    // ✅ Backfill (legacy treated as single)
    let backfill = null;
    try {
      const { backfillMatchingArticlesFromLibraryImage } = require("../services/imageBackfill");
      backfill = await backfillMatchingArticlesFromLibraryImage(doc, {
        limit: 300,
        lookbackHours: 168,
        onlyAi: true,
      });
    } catch (e) {
      console.error("[ImageLibrary:createImage] backfill error:", e?.message || e);
      backfill = { ok: false, error: String(e?.message || e) };
    }

    return res.json({ ok: true, image: doc, backfill });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ error: "This publicId already exists in Image Library" });
    }
    console.error("[ImageLibrary:createImage]", err);
    return res.status(500).json({ error: "Failed to create image library record" });
  }
};

exports.resolvePublicId = async (req, res) => {
  try {
    const publicId = String(req.query?.publicId || "").trim();
    if (!publicId) {
      return res.status(400).json({ ok: false, error: "publicId is required" });
    }

    const doc = await ImageLibrary.findOne({ publicId }).lean();
    if (!doc) {
      return res.status(404).json({ ok: false, error: "Image not found for this publicId" });
    }

    return res.json({ ok: true, publicId: doc.publicId, url: doc.url });
  } catch (err) {
    console.error("[ImageLibrary:resolvePublicId]", err);
    return res.status(500).json({ ok: false, error: "Failed to resolve publicId" });
  }
};

exports.listImages = async (req, res) => {
  try {
    const { tag, category, source, q, limit = 50, page = 1 } = req.query || {};

    const filter = {};

    if (category) filter.category = String(category).trim();
    if (source) filter.source = String(source).trim();

    if (tag) {
      const terms = String(tag)
        .split(/[\s,|]+/g)
        .map(normalizeTag)
        .filter(Boolean);

      if (terms.length === 1) {
        filter.tags = { $elemMatch: { $regex: escapeRegex(terms[0]), $options: "i" } };
      } else if (terms.length > 1) {
        filter.$or = [
          ...(filter.$or || []),
          ...terms.map((term) => ({
            tags: { $elemMatch: { $regex: escapeRegex(term), $options: "i" } },
          })),
        ];
      }
    }

    // optional search by publicId or url
    if (q) {
      const s = String(q).trim();
      filter.$or = [
        { publicId: { $regex: s, $options: "i" } },
        { url: { $regex: s, $options: "i" } },
      ];
    }

    const perPage = Math.min(200, Math.max(1, Number(limit) || 50));
    const pageNum = Math.max(1, Number(page) || 1);
    const skip = (pageNum - 1) * perPage;

    const [items, total] = await Promise.all([
      ImageLibrary.find(filter)
        .sort({ priority: -1, createdAt: -1 })
        .skip(skip)
        .limit(perPage)
        .lean(),
      ImageLibrary.countDocuments(filter),
    ]);

    return res.json({
      ok: true,
      total,
      page: pageNum,
      limit: perPage,
      items,
    });
  } catch (err) {
    console.error("[ImageLibrary:listImages]", err);
    return res.status(500).json({ error: "Failed to list images" });
  }
};

exports.updateImage = async (req, res) => {
  try {
    const { id } = req.params;
    const { tags, category, priority, source } = req.body || {};

    const update = {};
    if (tags !== undefined) update.tags = normalizeTags(tags);
    if (category !== undefined) update.category = String(category || "").trim();
    if (priority !== undefined) update.priority = Number(priority) || 0;
    if (source !== undefined) update.source = String(source || "").trim();

    const doc = await ImageLibrary.findByIdAndUpdate(id, update, { new: true });
    if (!doc) return res.status(404).json({ error: "Image not found" });

    return res.json({ ok: true, image: doc });
  } catch (err) {
    console.error("[ImageLibrary:updateImage]", err);
    return res.status(500).json({ error: "Failed to update image" });
  }
};

exports.deleteImage = async (req, res) => {
  try {
    const { id } = req.params;
    const deleteFromCloudinary =
      String(req.query.deleteFromCloudinary || "").toLowerCase() === "true";

    const doc = await ImageLibrary.findById(id);
    if (!doc) return res.status(404).json({ error: "Image not found" });

    await ImageLibrary.deleteOne({ _id: id });

    let cloudinaryResult = null;
    if (deleteFromCloudinary) {
      try {
        cloudinaryResult = await deleteCloudinaryAsset(doc.publicId);
      } catch (e) {
        console.error("[ImageLibrary:deleteImage] Cloudinary delete failed:", e);
        cloudinaryResult = { error: "cloudinary_delete_failed" };
      }
    }

    return res.json({ ok: true, deletedId: id, cloudinary: cloudinaryResult });
  } catch (err) {
    console.error("[ImageLibrary:deleteImage]", err);
    return res.status(500).json({ error: "Failed to delete image" });
  }
};
