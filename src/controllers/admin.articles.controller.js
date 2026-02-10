// backend/src/controllers/admin.articles.controller.js

const Article = require("../models/Article");
const { buildImageVariants } = require("../services/imageVariants");
const { decideAndAttach } = require("../services/imageStrategy");
const {
  uploadDriveImageToCloudinary,
  uploadDriveVideoToCloudinary,
} = require("../services/googleDriveUploader");

const slugify = require("slugify");

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
const PLACEHOLDER_HOSTS = ["example.com", "cdn.example", "your-cdn.example"];

function isPlaceholderUrl(url = "") {
  if (!url) return true;
  try {
    const { hostname } = new URL(url);
    return (
      !hostname ||
      PLACEHOLDER_HOSTS.includes(hostname) ||
      hostname.includes("example")
    );
  } catch {
    return true;
  }
}

function isPlaceholderPublicId(pid = "") {
  if (!pid) return true;
  const s = String(pid).toLowerCase();

  const def = String(
    process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID ||
      "news-images/defaults/fallback-hero"
  ).toLowerCase();

  if (s === def) return true;
  return s.includes("placeholder") || s.includes("example") || s === "news/default";
}

function ensureSlug(a) {
  if (!a.slug && a.title) {
    a.slug = slugify(a.title, { lower: true, strict: true });
  }
}

function normalizeIncoming(raw = {}) {
  const a = { ...raw };

  a.status = a.status || "draft";
  a.title = a.title?.trim();
  a.slug = a.slug?.trim();
  a.category = a.category?.trim();

  // normalize homepage placement
  a.homepagePlacement = String(a.homepagePlacement || "none")
    .trim()
    .toLowerCase();

  if (!["none", "top", "latest", "trending"].includes(a.homepagePlacement)) {
    a.homepagePlacement = "none";
  }

  if (!Array.isArray(a.tags) && typeof a.tags === "string") {
    a.tags = a.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(a.tags)) a.tags = [];

  // IMPORTANT: empty strings should not block autopick
  if (typeof a.imageUrl === "string" && !a.imageUrl.trim()) delete a.imageUrl;
  if (typeof a.imagePublicId === "string" && !a.imagePublicId.trim()) delete a.imagePublicId;

  if (isPlaceholderPublicId(a.imagePublicId)) delete a.imagePublicId;
  if (isPlaceholderUrl(a.imageUrl)) delete a.imageUrl;

  return a;
}

// Build final url variants from Cloudinary publicId
function finalizeImageFields(article) {
  if (!article.imagePublicId) return;

  const vars = buildImageVariants(article.imagePublicId);

  if (!article.imageUrl) article.imageUrl = vars.hero;
  if (!article.ogImage) article.ogImage = vars.og;
  if (!article.thumbImage) article.thumbImage = vars.thumb;

  if (!article.imageAlt) {
    article.imageAlt = article.title || "News image";
  }
}

// ✅ VIDEO helper: Drive URL → Cloudinary video URL
async function maybeUploadDriveVideo(article) {
  if (typeof article.videoUrl !== "string") return;

  const raw = article.videoUrl.trim();
  if (!raw) return;

  if (!raw.includes("drive.google.com")) return;

  article.videoSourceUrl = raw;

  const uploadedVideo = await uploadDriveVideoToCloudinary(raw, {
    folder: process.env.CLOUDINARY_VIDEO_FOLDER || "news-videos",
  });

  article.videoPublicId = uploadedVideo.public_id;
  article.videoUrl = uploadedVideo.secure_url;
}

// helper: treat as a real manual URL only if it starts with http(s)
function isRealManualHttpUrl(u) {
  if (typeof u !== "string") return false;
  const s = u.trim();
  if (!s) return false;
  if (!/^https?:\/\//i.test(s)) return false;
  if (isPlaceholderUrl(s)) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────
// CREATE ARTICLE — DB-FIRST AUTOPICK (ImageLibrary → Cloudinary → Default)
// ─────────────────────────────────────────────────────────────
exports.createOne = async (req, res) => {
  try {
    let article = normalizeIncoming(req.body);

    ensureSlug(article);

    article.status = String(article.status || "draft").toLowerCase();
    if (article.status === "published" && !article.publishedAt) {
      article.publishedAt = new Date();
    }

    // ✅ Manual imageUrl provided → upload to Cloudinary and lock it in
    const manualUrlProvided =
      isRealManualHttpUrl(article.imageUrl) && !article.imagePublicId;

    if (manualUrlProvided) {
      const sourceUrl = article.imageUrl;

      const uploaded = await uploadDriveImageToCloudinary(article.imageUrl, {
        folder: process.env.CLOUDINARY_FOLDER || "news-images",
      });

      article.imagePublicId = uploaded.public_id;
      article.imageUrl = uploaded.secure_url;

      article.autoImageDebug = {
        mode: "manual",
        sourceUrl,
        uploadedTo: "cloudinary",
        publicId: uploaded.public_id || null,
        url: uploaded.secure_url || null,
        pickedAt: new Date().toISOString(),
      };

      // manual means not auto-picked
      article.autoImagePicked = false;
      article.autoImagePickedAt = null;
    } else {
      // ✅ AUTO PICK (DB-first strategy)
      await decideAndAttach(article);

      // decideAndAttach sets:
      // - article.imagePublicId / imageUrl
      // - article.autoImageDebug
      // - article.autoImagePicked / autoImagePickedAt
    }

    await maybeUploadDriveVideo(article);

    finalizeImageFields(article);

    const saved = await Article.create(article);
    return res.json(saved.toObject());
  } catch (err) {
    console.error("[admin.articles] createOne error:", err);
    return res.status(500).json({ ok: false, error: String(err.message) });
  }
};

// ─────────────────────────────────────────────────────────────
// IMPORT MANY — DB-FIRST AUTOPICK (ImageLibrary → Cloudinary → Default)
// ─────────────────────────────────────────────────────────────
exports.importMany = async (req, res) => {
  try {
    const { items = [] } = req.body || {};
    const results = [];

    for (const raw of items) {
      try {
        let article = normalizeIncoming(raw);
        ensureSlug(article);

        article.status = String(article.status || "draft").toLowerCase();
        if (article.status === "published" && !article.publishedAt) {
          article.publishedAt = new Date();
        }

        const manualUrlProvided =
          isRealManualHttpUrl(article.imageUrl) && !article.imagePublicId;

        if (manualUrlProvided) {
          const sourceUrl = article.imageUrl;

          const uploaded = await uploadDriveImageToCloudinary(article.imageUrl, {
            folder: process.env.CLOUDINARY_FOLDER || "news-images",
          });

          article.imagePublicId = uploaded.public_id;
          article.imageUrl = uploaded.secure_url;

          article.autoImageDebug = {
            mode: "manual",
            sourceUrl,
            uploadedTo: "cloudinary",
            publicId: uploaded.public_id || null,
            url: uploaded.secure_url || null,
            pickedAt: new Date().toISOString(),
          };

          article.autoImagePicked = false;
          article.autoImagePickedAt = null;
        } else {
          await decideAndAttach(article);
        }

        await maybeUploadDriveVideo(article);

        finalizeImageFields(article);

        const saved = await Article.create(article);
        results.push({ ok: true, id: saved._id, slug: saved.slug });
      } catch (e) {
        results.push({ ok: false, error: String(e.message) });
      }
    }

    return res.json({ ok: true, results });
  } catch (err) {
    console.error("[importMany]", err);
    return res.status(500).json({ ok: false, error: String(err.message) });
  }
};

// ─────────────────────────────────────────────────────────────
// PREVIEW MANY — DB-FIRST AUTOPICK (NO DB WRITES)
// ─────────────────────────────────────────────────────────────
exports.previewMany = async (req, res) => {
  try {
    const { items = [] } = req.body || {};
    const previews = [];

    for (const raw of items) {
      let article = normalizeIncoming(raw);
      ensureSlug(article);

      const manualUrlProvided =
        isRealManualHttpUrl(article.imageUrl) && !article.imagePublicId;

      // ✅ Preview should NOT upload manual images (keep preview cheap)
      if (!manualUrlProvided && !article.imagePublicId) {
        await decideAndAttach(article);
      }

      finalizeImageFields(article);

      previews.push({
        title: article.title,
        slug: article.slug,
        imagePublicId: article.imagePublicId,
        imageUrl: article.imageUrl,
        ogImage: article.ogImage,
        thumbImage: article.thumbImage,
        autoImageDebug: article.autoImageDebug || article._autoImageDebug || null,
        autoImagePicked: article.autoImagePicked || false,
      });
    }

    return res.json({ ok: true, previews });
  } catch (err) {
    console.error("[previewMany]", err);
    return res.status(500).json({ ok: false, error: String(err.message) });
  }
};
