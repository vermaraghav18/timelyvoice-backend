// backend/src/controllers/admin.imageLibrary.controller.js
const ImageLibrary = require("../models/ImageLibrary");
const {
  uploadImageBuffer,
  deleteCloudinaryAsset,
} = require("../services/cloudinary.service");

// ✅ Google Drive helpers (ONLY ONCE)
const {
  listFilesInFolder,
  downloadFileBuffer,
} = require("../services/googleDrive");

// ✅ auto tag service
const {
  generateImageTagsFromUrl,
} = require("../services/imageAutoTags.service");

// -----------------------------
// Tag helpers
// -----------------------------
function normalizeTag(raw = "") {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^#+/g, "")
    .replace(/[^a-z0-9_-]/g, "");
}

/**
 * ✅ Upgraded normalizer:
 * - Accepts: "donald trump, usa" OR ["donald trump","usa"]
 * - Expands multi-word tags:
 *   "donald trump" -> ["donald trump","donald","trump","donaldtrump"]
 * - Then cleans to your existing format (lowercase, no spaces/special chars)
 */
function normalizeTags(input) {
  let arr = [];
  if (typeof input === "string") {
    arr = input.split(/[,|]/g);
  } else if (Array.isArray(input)) {
    arr = input;
  }

  const expanded = [];
  for (const raw of arr) {
    const s = String(raw || "").trim();
    if (!s) continue;

    expanded.push(s);

    const words = s.split(/\s+/g).filter(Boolean);
    if (words.length > 1) {
      for (const w of words) expanded.push(w);
      expanded.push(words.join(""));
    }
  }

  const clean = expanded.map(normalizeTag).filter(Boolean);
  return Array.from(new Set(clean));
}

function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

exports.createImage = async (req, res) => {
  try {
    const { tags, category = "", source = "manual", priority = 0 } = req.body || {};
    const { publicId, url } = req.body || {};

    const multi = Array.isArray(req?.files?.files) ? req.files.files : [];
    const single = Array.isArray(req?.files?.file) ? req.files.file : [];
    const allFiles = [...single, ...multi].filter(Boolean);

    if (allFiles.length > 0) {
      const created = [];
      const failed = [];

      const requestTagsNormalized = normalizeTags(tags);

      for (const f of allFiles) {
        try {
          if (!f?.buffer) {
            failed.push({
              name: f?.originalname || "unknown",
              error: "file buffer missing",
            });
            continue;
          }

          const up = await uploadImageBuffer(f.buffer, {
            folder: process.env.CLOUDINARY_LIBRARY_FOLDER || "news-images/library",
          });

          let finalTags = requestTagsNormalized;
          if (!finalTags || finalTags.length === 0) {
            const auto = await generateImageTagsFromUrl(up.url, { max: 10 });
            finalTags = normalizeTags(auto?.tags || []);
          }

          const doc = await ImageLibrary.create({
            publicId: up.public_id,
            url: up.url,
            tags: finalTags,
            category: String(category || "").trim(),
            source,
            priority: Number(priority) || 0,
          });

          created.push(doc);
        } catch (err) {
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
        const firstFail = failed?.[0]?.error ? ` First error: ${failed[0].error}` : "";

        return res.status(dupOnly ? 409 : 500).json({
          ok: false,
          error: dupOnly
            ? "All selected images already exist in Image Library (duplicate publicId)."
            : `Failed to upload image(s).${firstFail}`,
          failed,
        });
      }

      let backfill = null;
      if (created.length === 1) {
        try {
          const { backfillMatchingArticlesFromLibraryImage } = require("../services/imageBackfill");
          backfill = await backfillMatchingArticlesFromLibraryImage(created[0], {
            limit: 300,
            lookbackHours: 168,
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
        images: created,
        image: created.length === 1 ? created[0] : undefined,
        failed,
        backfill,
      });
    }

    if (!publicId) {
      return res.status(400).json({
        error: "file(s) is required (or provide publicId for legacy mode)",
      });
    }

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const cleanPublicId = String(publicId).trim();

    let finalLegacyUrl = url ? String(url).trim() : "";
    finalLegacyUrl = finalLegacyUrl.replace(/\s+/g, "");

    if (!finalLegacyUrl || finalLegacyUrl.includes("YOUR_CLOUD_NAME")) {
      if (!cloudName) {
        return res.status(500).json({ error: "CLOUDINARY_CLOUD_NAME is missing in env" });
      }
      finalLegacyUrl = `https://res.cloudinary.com/${cloudName}/image/upload/v1/${cleanPublicId}.jpg`;
    }

    let finalTags = normalizeTags(tags);
    if (!finalTags || finalTags.length === 0) {
      const auto = await generateImageTagsFromUrl(finalLegacyUrl, { max: 10 });
      finalTags = normalizeTags(auto?.tags || []);
    }

    const doc = await ImageLibrary.create({
      publicId: cleanPublicId,
      url: finalLegacyUrl,
      tags: finalTags,
      category: String(category || "").trim(),
      source,
      priority: Number(priority) || 0,
    });

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

exports.listDriveFiles = async (req, res) => {
  try {
    const folderId =
      String(req.query.folderId || "").trim() ||
      String(process.env.GOOGLE_DRIVE_NEWS_FOLDER_ID || "").trim();

    if (!folderId) {
      return res.status(400).json({
        ok: false,
        error: "Missing folderId (and GOOGLE_DRIVE_NEWS_FOLDER_ID is not set).",
      });
    }

    const files = await listFilesInFolder(folderId);

    return res.json({
      ok: true,
      folderId,
      count: Array.isArray(files) ? files.length : 0,
      files: (files || []).map((f) => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        modifiedTime: f.modifiedTime,
        thumbnailLink: f.thumbnailLink,
        webViewLink: f.webViewLink,
      })),
    });
  } catch (err) {
    console.error("[ImageLibrary:listDriveFiles]", err);
    return res.status(500).json({
      ok: false,
      error: err?.response?.data?.error?.message || err?.message || "Failed to list Drive files",
    });
  }
};

exports.importDriveFiles = async (req, res) => {
  try {
    console.log("[DriveImport] HIT /drive/import body:", {
      fileIdsCount: Array.isArray(req.body?.fileIds) ? req.body.fileIds.length : 0,
      category: req.body?.category,
      priority: req.body?.priority,
      tagsLen: String(req.body?.tags || "").length,
    });

    const { fileIds, tags = "", category = "", priority = 0 } = req.body || {};

    const ids = Array.isArray(fileIds)
      ? fileIds.map((x) => String(x).trim()).filter(Boolean)
      : [];

    if (ids.length === 0) {
      return res.status(400).json({ ok: false, error: "fileIds[] is required" });
    }

    const requestTagsNormalized = normalizeTags(tags);

    const created = [];
    const failed = [];

    const runOne = async (fileId) => {
      const t0 = Date.now();
      let tDownload = 0;
      let tUpload = 0;
      let tDb = 0;

      try {
        const t1 = Date.now();
        const buf = await downloadFileBuffer(fileId);
        tDownload = Date.now() - t1;

        if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
          throw new Error("Drive download returned empty/invalid buffer");
        }

        const t2 = Date.now();
        const up = await uploadImageBuffer(buf, {
          folder: process.env.CLOUDINARY_LIBRARY_FOLDER || "news-images/library",
          overwrite: false,
        });
        tUpload = Date.now() - t2;

        let finalTags = requestTagsNormalized;
        if (!finalTags || finalTags.length === 0) {
          const auto = await generateImageTagsFromUrl(up.url, { max: 10 });
          finalTags = normalizeTags(auto?.tags || []);
        }

        const t3 = Date.now();
        const doc = await ImageLibrary.create({
          publicId: up.public_id,
          url: up.url,
          tags: finalTags,
          category: String(category || "").trim(),
          source: "drive",
          priority: Number(priority) || 0,
        });
        tDb = Date.now() - t3;

        created.push(doc);

        console.log(
          `[DriveImport] OK fileId=${fileId} total=${Date.now() - t0}ms download=${tDownload}ms upload=${tUpload}ms db=${tDb}ms publicId=${up.public_id}`
        );
      } catch (err) {
        const status = err?.response?.status || null;
        const reason =
          err?.response?.data?.error?.message ||
          err?.response?.data?.error ||
          err?.message ||
          "import_failed";

        console.error(
          "[DriveImport] FAIL fileId=",
          fileId,
          "status=",
          status,
          "reason=",
          reason
        );

        failed.push({ fileId, status, error: reason });
      }
    };

    const CONCURRENCY = 3;
    const queue = [...ids];

    const workers = new Array(CONCURRENCY).fill(0).map(async () => {
      while (queue.length > 0) {
        const fileId = queue.shift();
        if (!fileId) continue;
        // eslint-disable-next-line no-await-in-loop
        await runOne(fileId);
      }
    });

    await Promise.all(workers);

    if (created.length === 0) {
      const firstFail = failed?.[0]?.error ? ` First error: ${failed[0].error}` : "";
      const statusCode =
        failed.length > 0 && failed.every((x) => x?.status === 403) ? 403 :
        failed.length > 0 && failed.every((x) => x?.status === 404) ? 404 :
        500;

      return res.status(statusCode).json({
        ok: false,
        error: `Failed to import Drive images.${firstFail}`,
        failed,
      });
    }

    return res.json({
      ok: true,
      count: created.length,
      images: created,
      failed,
    });
  } catch (err) {
    console.error("[ImageLibrary:importDriveFiles] fatal:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "Failed to import Drive images",
    });
  }
};
