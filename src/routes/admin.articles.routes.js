// backend/src/routes/admin.articles.routes.js
// Admin routes for listing, previewing, editing and publishing Article drafts

const express = require("express");
const router = express.Router();

// NEW: deps for Drive → Cloudinary override
const fs = require("fs");
const path = require("path");
const { v2: cloudinary } = require("cloudinary");
const { getDriveClient } = require("../services/driveClient");

// Models
const Article = require("../models/Article");
const Category = require("../models/Category");

// Image strategy + variants
const { decideAndAttach } = require("../services/imageStrategy");
const { buildImageVariants } = require("../services/imageVariants");

// 👇 NEW: AI Image service (OpenRouter / Gemini)
const { generateAiHeroForArticle } = require("../services/aiImage.service");

// Controller for create/import/preview
const ctrl = require("../controllers/admin.articles.controller");

const slugify = require("slugify");

// ────────────────────────────────────────────────────────────────────────────────
// Default image + URL builder (no Cloudinary SDK magic)
// ────────────────────────────────────────────────────────────────────────────────

const DEFAULT_PID =
  process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID ||
  "news-images/defaults/fallback-hero";

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || null;

function buildCloudinaryUrl(publicId, transform = "") {
  if (!CLOUD_NAME || !publicId) return "";
  const base = `https://res.cloudinary.com/${CLOUD_NAME}/image/upload`;
  const t = transform ? `${transform}/` : "";
  return `${base}/${t}${publicId}`;
}

// Strip placeholders like "leave it empty" etc. and wrapping quotes
function sanitizeImageUrl(u) {
  if (!u) return "";
  let s = String(u).trim();
  if (!s) return "";
  s = s.replace(/^['"]+|['"]+$/g, "").trim();
  if (!s) return "";

  const lower = s.toLowerCase();

  if (
    /^leave\s+(it|this)?\s*empty$/.test(lower) ||
    lower === "leave empty" ||
    lower === "none" ||
    lower === "n/a"
  ) {
    return "";
  }

  return s;
}

console.log("[admin.articles] DEFAULT_IMAGE_PUBLIC_ID =", DEFAULT_PID);
console.log("[admin.articles] CLOUD_NAME =", CLOUD_NAME);

// ────────────────────────────────────────────────────────────────────────────────
// Cloudinary + Drive setup for manual Drive overrides
// ────────────────────────────────────────────────────────────────────────────────

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const TEMP_DIR = path.join(__dirname, "../../tmp-drive-manual");
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const { drive, credSource } = getDriveClient
  ? getDriveClient()
  : { drive: null, credSource: "none" };

// Extract fileId from common Google Drive URLs
function extractDriveFileId(raw = "") {
  const s = String(raw || "").trim();
  if (!s.includes("drive.google.com")) return null;

  const byPath = s.match(/\/file\/d\/([^/]+)/);
  if (byPath && byPath[1]) return byPath[1];

  const byParam = s.match(/[?&]id=([^&]+)/);
  if (byParam && byParam[1]) return byParam[1];

  return null;
}

// Download a Drive file by ID → upload to Cloudinary → return { publicId, url }
async function uploadDriveFileToCloudinary(fileId) {
  if (!fileId || !drive) {
    console.warn(
      "[admin.articles] uploadDriveFileToCloudinary: missing fileId or drive client; credSource =",
      credSource
    );
    return null;
  }

  const destPath = path.join(TEMP_DIR, `${fileId}.img`);
  const dest = fs.createWriteStream(destPath);

  try {
    const response = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );

    await new Promise((resolve, reject) => {
      response.data.on("end", resolve).on("error", reject).pipe(dest);
    });

    const uploaded = await cloudinary.uploader.upload(destPath, {
      folder: process.env.CLOUDINARY_FOLDER
        ? `${process.env.CLOUDINARY_FOLDER}/manual`
        : "news-images/manual",
      resource_type: "image",
    });

    try {
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    } catch (err) {
      console.warn("[admin.articles] temp cleanup warning:", err.message || err);
    }

    return {
      publicId: uploaded.public_id,
      url: uploaded.secure_url,
    };
  } catch (err) {
    console.error(
      "[admin.articles] uploadDriveFileToCloudinary error:",
      err.message || err
    );
    try {
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    } catch (_) {}
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// Helpers used by PATCH
// ────────────────────────────────────────────────────────────────────────────────

const PLACEHOLDER_HOSTS = ["your-cdn.example", "cdn.example.com", "example.com"];

function isPlaceholderUrl(u = "") {
  try {
    const { hostname } = new URL(u);
    if (!hostname) return true;
    return (
      PLACEHOLDER_HOSTS.includes(hostname) ||
      hostname.endsWith(".example") ||
      hostname.includes("cdn.example")
    );
  } catch {
    return true;
  }
}

// 🔥 default placeholder ≠ real image (so autopick must still run)
function isDefaultPlaceholder(publicId, imageUrl) {
  return (
    (typeof publicId === "string" &&
      (publicId.includes("/defaults/") ||
        publicId.includes("news-images/default"))) ||
    (typeof imageUrl === "string" && imageUrl.includes("news-images/default"))
  );
}

/**
 * IMPORTANT CHANGE (PRODUCTION FIX):
 * Do NOT force DEFAULT_PID into the DB when imagePublicId is empty.
 * We compute default on GET/LIST already. Storing defaults in DB makes "clear" impossible.
 */
function finalizeImageFields(article) {
  if (!article) return;

  article.imageUrl = sanitizeImageUrl(article.imageUrl);
  article.ogImage = sanitizeImageUrl(article.ogImage);
  article.thumbImage = sanitizeImageUrl(article.thumbImage);

  // Only build derived URLs if we have a real publicId.
  const publicId = article.imagePublicId;
  if (!publicId || !CLOUD_NAME) return;

  if (!article.imageUrl) article.imageUrl = buildCloudinaryUrl(publicId);

  if (!article.ogImage) {
    article.ogImage = buildCloudinaryUrl(
      publicId,
      "c_fill,g_auto,h_630,w_1200,f_jpg"
    );
  }

  if (!article.thumbImage) {
    article.thumbImage = buildCloudinaryUrl(
      publicId,
      "c_fill,g_auto,h_300,w_400,f_webp"
    );
  }

  if (!article.imageAlt) article.imageAlt = article.title || "News image";
}

// ────────────────────────────────────────────────────────────────────────────────
// CATEGORY NORMALIZATION (so admin never sees ObjectId in UI)
// ────────────────────────────────────────────────────────────────────────────────

function looksLikeObjectId(val) {
  return typeof val === "string" && /^[a-f0-9]{24}$/i.test(val);
}

function escapeRegex(str = "") {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeArticlesWithCategories(
  items,
  categoriesMapById = new Map(),
  categoriesMapByName = new Map()
) {
  return items.map((it) => {
    const a = { ...it };

    if (
      a.category &&
      typeof a.category === "object" &&
      (a.category._id || a.category.id || a.category.name)
    ) {
      const id = String(a.category._id || a.category.id || "");
      const name = a.category.name || null;
      const slug =
        a.category.slug ||
        (name ? slugify(name, { lower: true, strict: true }) : null);
      a.category = name || id ? { id: id || null, name, slug } : null;
      return a;
    }

    if (looksLikeObjectId(a.category)) {
      const c = categoriesMapById.get(String(a.category));
      if (c) {
        a.category = {
          id: String(c._id),
          name: c.name || null,
          slug:
            c.slug ||
            (c.name ? slugify(c.name, { lower: true, strict: true }) : null),
        };
      } else {
        a.category = { id: String(a.category), name: null, slug: null };
      }
      return a;
    }

    if (typeof a.category === "string" && a.category.trim()) {
      const name = a.category.trim();
      const c = categoriesMapByName.get(name) || null;
      a.category = {
        id: c ? String(c._id) : null,
        name,
        slug: c?.slug || slugify(name, { lower: true, strict: true }),
      };
      return a;
    }

    a.category = null;
    return a;
  });
}

const toCatText = (v) =>
  Array.isArray(v)
    ? v.map(toCatText).filter(Boolean)
    : v && typeof v === "object"
    ? v.name || v.slug || ""
    : v || "";

// ────────────────────────────────────────────────────────────────────────────────
// CLOUDINARY PUBLIC ID DERIVER (for pasted image URLs)
// ────────────────────────────────────────────────────────────────────────────────

function deriveCloudinaryPublicIdFromUrl(url = "") {
  if (typeof url !== "string" || !url.includes("/image/upload/")) return null;
  try {
    const afterUpload = url.split("/image/upload/")[1];
    if (!afterUpload) return null;

    const clean = afterUpload.split(/[?#]/)[0];
    const segs = clean.split("/");

    let i = 0;
    while (i < segs.length && (segs[i].includes(",") || segs[i].includes(":")))
      i++;
    if (i < segs.length && /^v\d+$/i.test(segs[i])) i++;

    const publicPath = segs.slice(i).join("/");
    if (!publicPath) return null;

    return publicPath.replace(/\.[a-z0-9]+$/i, "") || null;
  } catch {
    return null;
  }
}

function normalizeRemoteImageUrl(raw = "") {
  const s = String(raw || "").trim();
  if (!s) return null;

  if (s.includes("drive.google.com")) {
    const fileId = extractDriveFileId(s);
    if (fileId) {
      return `https://drive.google.com/uc?export=download&id=${fileId}`;
    }
    return s;
  }

  return s;
}

// ────────────────────────────────────────────────────────────────────────────────
// ✅ NEW: FORCE RE-PICK IMAGE — POST /api/admin/articles/:id/repick-image
// (easy for Postman, no guessing)
// ────────────────────────────────────────────────────────────────────────────────
router.post("/:id/repick-image", async (req, res) => {
  try {
    const { id } = req.params;

    const article = await Article.findById(id).lean();
    if (!article) return res.status(404).json({ ok: false, error: "not_found" });

    // Clear image fields so autopick is allowed
    article.imagePublicId = null;
    article.imageUrl = null;
    article.ogImage = null;
    article.thumbImage = null;

    // Clear old debug so it doesn't confuse you
    article.autoImageDebug = null;
    article._autoImageDebug = null;
    article.autoImagePicked = false;
    article.autoImagePickedAt = null;

    await decideAndAttach(article, {
      imageStrategy: "cloudinary",
      fallbacks: ["stock"],
    });

    finalizeImageFields(article);

    const toSave = {
      imagePublicId: article.imagePublicId || null,
      imageUrl: article.imageUrl || null,
      ogImage: article.ogImage || null,
      thumbImage: article.thumbImage || null,
      imageAlt: article.imageAlt || null,
      autoImageDebug: article.autoImageDebug || article._autoImageDebug || null,
      autoImagePicked: !!article.autoImagePicked,
      autoImagePickedAt: article.autoImagePickedAt || new Date(),
    };

    const updated = await Article.findByIdAndUpdate(
      id,
      { $set: toSave },
      { new: true }
    ).lean();

    return res.json({ ok: true, article: updated });
  } catch (err) {
    console.error("[admin.articles] repick-image error", err);
    return res.status(500).json({ ok: false, error: "repick_failed" });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// CREATE (single) — POST /api/admin/articles
router.post("/", async (req, res, next) => {
  try {
    if (req.body && typeof req.body === "object") {
      for (const key of ["imageUrl", "ogImage", "thumbImage"]) {
        if (Object.prototype.hasOwnProperty.call(req.body, key)) {
          const cleaned = sanitizeImageUrl(req.body[key]);
          if (!cleaned || isPlaceholderUrl(cleaned)) delete req.body[key];
          else req.body[key] = cleaned;
        }
      }

      if (
        Object.prototype.hasOwnProperty.call(req.body, "imagePublicId") &&
        String(req.body.imagePublicId || "").trim() === ""
      ) {
        delete req.body.imagePublicId;
      }
    }

    if (
      req.body &&
      (Object.prototype.hasOwnProperty.call(req.body, "category") ||
        Object.prototype.hasOwnProperty.call(req.body, "categorySlug"))
    ) {
      let incomingName = "";
      let incomingSlug = "";
      let incomingId = "";

      if (req.body.category && typeof req.body.category === "object") {
        incomingId = String(
          req.body.category.id || req.body.category._id || ""
        ).trim();
        incomingName = String(req.body.category.name || "").trim();
        incomingSlug = String(req.body.category.slug || "").trim();
      } else if (typeof req.body.category === "string") {
        incomingName = req.body.category.trim();
      }

      if (
        typeof req.body.categorySlug === "string" &&
        req.body.categorySlug.trim()
      ) {
        incomingSlug = req.body.categorySlug.trim();
      }

      let catDoc = null;

      if (incomingId && looksLikeObjectId(incomingId)) {
        catDoc = await Category.findById(incomingId)
          .select("_id name slug")
          .lean();
      }

      if (!catDoc && (incomingSlug || incomingName)) {
        const slugGuess =
          incomingSlug ||
          slugify(incomingName, { lower: true, strict: true });
        catDoc = await Category.findOne({
          $or: [
            { slug: slugGuess },
            {
              name: new RegExp(
                `^${escapeRegex(incomingName || slugGuess)}$`,
                "i"
              ),
            },
          ],
        })
          .select("_id name slug")
          .lean();
      }

      if (catDoc) {
        req.body.category = catDoc.name;
        req.body.categorySlug = String(catDoc.slug || "").toLowerCase();
      } else {
        const finalName = (incomingName || incomingSlug || "").trim();
        req.body.category = finalName || "General";
        req.body.categorySlug =
          slugify(req.body.category, { lower: true, strict: true }) || "general";
      }
    }

    return ctrl.createOne(req, res, next);
  } catch (err) {
    console.error("[admin.articles] create wrapper error", err);
    return res.status(500).json({ error: "failed_to_create" });
  }
});

// BULK IMPORT — POST /api/admin/articles/import
router.post("/import", ctrl.importMany);

// PREVIEW BULK IMPORT (no DB writes) — POST /api/admin/articles/preview-import
router.post("/preview-import", ctrl.previewMany);

// IMPORT IMAGE FROM URL (Cloudinary + Google Drive support)
router.post("/import-image-from-url", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== "string" || !url.trim()) {
      return res.status(400).json({ error: "url_required" });
    }

    const normalized = normalizeRemoteImageUrl(url);

    const maybePid = deriveCloudinaryPublicIdFromUrl(normalized);
    if (maybePid) {
      return res.json({
        ok: true,
        publicId: maybePid,
        url: buildCloudinaryUrl(maybePid),
      });
    }

    if (normalized.includes("drive.google.com")) {
      const fileId = extractDriveFileId(normalized);
      if (!fileId) {
        return res.status(400).json({ error: "drive_file_id_not_found" });
      }

      const uploaded = await uploadDriveFileToCloudinary(fileId);
      if (!uploaded) {
        return res.status(500).json({ error: "drive_upload_failed" });
      }

      return res.json({
        ok: true,
        publicId: uploaded.publicId,
        url: uploaded.url,
      });
    }

    return res.status(400).json({ error: "unsupported_url" });
  } catch (err) {
    console.error(
      "[admin.articles] import-image-from-url failed",
      err?.message || err
    );
    return res.status(500).json({ error: "upload_failed" });
  }
});

// LIST DRAFTS — GET /api/admin/articles/drafts
router.get("/drafts", async (req, res) => {
  try {
    const q = {
      $and: [
        { $or: [{ status: "draft" }, { status: { $exists: false } }] },
        { $or: [{ publishedAt: { $exists: false } }, { publishedAt: null }] },
      ],
    };

    const rawDrafts = await Article.find(q)
      .select(
        "_id title slug status category summary homepagePlacement body publishedAt updatedAt createdAt imageUrl imagePublicId ogImage thumbImage imageAlt tags source sourceUrl videoUrl autoImageDebug _autoImageDebug autoImagePicked autoImagePickedAt"
      )
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    const idSet = new Set();
    const nameSet = new Set();
    for (const it of rawDrafts) {
      const c = it.category;
      if (!c) continue;
      if (typeof c === "object" && (c._id || c.id)) continue;
      if (looksLikeObjectId(c)) idSet.add(String(c));
      else if (typeof c === "string" && c.trim()) nameSet.add(c.trim());
    }

    const [docsById, docsByName] = await Promise.all([
      idSet.size
        ? Category.find({ _id: { $in: Array.from(idSet) } })
            .select("_id name slug")
            .lean()
        : [],
      nameSet.size
        ? Category.find({ name: { $in: Array.from(nameSet) } })
            .select("_id name slug")
            .lean()
        : [],
    ]);

    const categoriesMapById = new Map(
      (docsById || []).map((d) => [String(d._id), d])
    );
    const categoriesMapByName = new Map(
      (docsByName || []).map((d) => [d.name, d])
    );

    const normalizedDrafts = normalizeArticlesWithCategories(
      rawDrafts,
      categoriesMapById,
      categoriesMapByName
    );

    const drafts = normalizedDrafts.map((a) => {
      const clean = sanitizeImageUrl(a.imageUrl);
      const bestPid = a.imagePublicId || DEFAULT_PID;
      const imageUrl =
        clean || (bestPid && CLOUD_NAME ? buildCloudinaryUrl(bestPid) : "");

      return {
        ...a,
        imageUrl,
        category: toCatText(a.category),
        categories: Array.isArray(a.categories)
          ? a.categories.map(toCatText)
          : [],
        autoImageDebug: a.autoImageDebug || a._autoImageDebug || null,
      };
    });

    res.json(drafts);
  } catch (err) {
    console.error("[admin.articles] drafts error", err);
    res.status(500).json({ error: "failed_to_list_drafts" });
  }
});

// DELETE — DELETE /api/admin/articles/:id
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await Article.findByIdAndDelete(id).lean();
    if (!doc) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true, deletedId: id });
  } catch (err) {
    console.error("[admin.articles] delete error", err);
    return res.status(500).json({ error: "failed_to_delete_article" });
  }
});

// LIST — GET /api/admin/articles
router.get("/", async (req, res) => {
  try {
    const { status, category, q, page = 1, limit = 20 } = req.query;

    const and = [];
    if (status) and.push({ status: String(status).toLowerCase() });

    if (category) {
      const raw = String(category);
      const catDoc = await Category.findOne({
        $or: [{ slug: raw }, { slug: slugify(raw) }, { name: raw }],
      })
        .select("_id name")
        .lean();

      if (catDoc) {
        and.push({ $or: [{ category: catDoc.name }, { category: catDoc._id }] });
      } else {
        and.push({ $or: [{ "category.slug": raw }, { category: raw }] });
      }
    }

    if (q) {
      const rx = new RegExp(
        String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i"
      );
      and.push({ $or: [{ title: rx }, { summary: rx }, { body: rx }] });
    }

    const query = and.length ? { $and: and } : {};

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const perPage = Math.max(1, Math.min(200, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * perPage;

    const MAX_LIST = 1000;

    const [allItems, total] = await Promise.all([
      Article.find(query)
        .select(
          "_id title slug status category summary homepagePlacement body publishedAt updatedAt createdAt imageUrl imagePublicId ogImage thumbImage imageAlt tags source sourceUrl videoUrl autoImageDebug _autoImageDebug autoImagePicked autoImagePickedAt"
        )
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(MAX_LIST)
        .populate({
          path: "category",
          select: "name slug",
          options: { lean: true },
        })
        .lean(),
      Article.countDocuments(query),
    ]);

    function getSortDate(doc) {
      const candidate =
        (doc.publishedAt && new Date(doc.publishedAt)) ||
        (doc.updatedAt && new Date(doc.updatedAt)) ||
        (doc.createdAt && new Date(doc.createdAt));
      if (!candidate || Number.isNaN(candidate.getTime())) return new Date(0);
      return candidate;
    }

    const sorted = (allItems || []).slice().sort((a, b) => {
      const aStatus = (a.status || "").toString().toLowerCase();
      const bStatus = (b.status || "").toString().toLowerCase();
      const aIsDraft = !aStatus || aStatus === "draft";
      const bIsDraft = !bStatus || bStatus === "draft";

      if (aIsDraft !== bIsDraft) return aIsDraft ? -1 : 1;

      const da = getSortDate(a);
      const db = getSortDate(b);
      return db - da;
    });

    const paged = sorted.slice(skip, skip + perPage);

    const normalized = normalizeArticlesWithCategories(
      paged,
      new Map(),
      new Map()
    );

    const items = normalized.map((a) => {
      const cleaned = sanitizeImageUrl(a.imageUrl);
      const bestPid = a.imagePublicId || DEFAULT_PID;
      const imageUrl =
        cleaned || (bestPid && CLOUD_NAME ? buildCloudinaryUrl(bestPid) : "");
      const imageAlt = a.imageAlt || a.title || "News image";

      return {
        ...a,
        imageUrl,
        imageAlt,
        category: toCatText(a.category),
        categories: Array.isArray(a.categories)
          ? a.categories.map(toCatText)
          : [],
        autoImageDebug: a.autoImageDebug || a._autoImageDebug || null,
      };
    });

    res.json({ items, total, page: pageNum, limit: perPage });
  } catch (err) {
    console.error("[admin.articles] list error", err);
    res.status(500).json({ error: "failed_to_list_articles" });
  }
});

// GET ONE — GET /api/admin/articles/:id
router.get("/:id", async (req, res) => {
  try {
    const raw = await Article.findById(req.params.id)
      .populate({
        path: "category",
        select: "name slug",
        options: { lean: true },
      })
      .lean();

    if (!raw) return res.status(404).json({ error: "not_found" });

    const items = normalizeArticlesWithCategories([raw]);
    const a = items[0];

    const cleaned = sanitizeImageUrl(a.imageUrl);
    const bestPid = a.imagePublicId || DEFAULT_PID;
    a.imageUrl =
      cleaned || (bestPid && CLOUD_NAME ? buildCloudinaryUrl(bestPid) : "");

    a.category = toCatText(a.category);
    a.categories = Array.isArray(a.categories)
      ? a.categories.map(toCatText)
      : [];
    a.autoImageDebug = a.autoImageDebug || a._autoImageDebug || null;

    res.json(a);
  } catch (err) {
    console.error("[admin.articles] get error", err);
    res.status(500).json({ error: "failed_to_get_article" });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// PATCH — PATCH /api/admin/articles/:id
router.patch("/:id", async (req, res) => {
  try {
    const allowed = [
      "title",
      "slug",
      "category",
      "categorySlug",
      "summary",
      "homepagePlacement",
      "imageUrl",
      "imagePublicId",
      "imageAlt",
      "ogImage",
      "thumbImage",
      "status",
      "tags",
      "body",
      "bodyHtml",
      "author",
      "year",
      "era",
      "videoUrl",
      "videoPublicId",
      "videoSourceUrl",
    ];

    const patch = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) patch[k] = req.body[k];
    }

    const hasPatch = (k) => Object.prototype.hasOwnProperty.call(patch, k);
    const nonEmptyStr = (v) => typeof v === "string" && v.trim().length > 0;

    if (hasPatch("category") || hasPatch("categorySlug")) {
      let incomingName = "";
      let incomingSlug = "";
      let incomingId = "";

      if (patch.category && typeof patch.category === "object") {
        incomingId = String(patch.category.id || patch.category._id || "").trim();
        incomingName = String(patch.category.name || "").trim();
        incomingSlug = String(patch.category.slug || "").trim();
      } else if (typeof patch.category === "string") {
        incomingName = patch.category.trim();
      }

      if (typeof patch.categorySlug === "string" && patch.categorySlug.trim()) {
        incomingSlug = patch.categorySlug.trim();
      }

      let catDoc = null;
      if (incomingId && looksLikeObjectId(incomingId)) {
        catDoc = await Category.findById(incomingId).select("_id name slug").lean();
      }

      if (!catDoc && (incomingSlug || incomingName)) {
        const slugGuess =
          incomingSlug || slugify(incomingName, { lower: true, strict: true });
        catDoc = await Category.findOne({
          $or: [
            { slug: slugGuess },
            { name: new RegExp(`^${escapeRegex(incomingName || slugGuess)}$`, "i") },
          ],
        })
          .select("_id name slug")
          .lean();
      }

      if (catDoc) {
        patch.category = catDoc.name;
        patch.categorySlug = String(catDoc.slug || "").toLowerCase();
      } else {
        const finalName = (incomingName || incomingSlug || "").trim();
        patch.category = finalName || "General";
        patch.categorySlug =
          slugify(patch.category, { lower: true, strict: true }) || "general";
      }
    }

    if (typeof patch.tags === "string") {
      patch.tags = patch.tags
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    if (patch.status === "published") {
      patch.publishedAt = new Date();
    }

    /**
     * PRODUCTION FIX:
     * If imageUrl is present in PATCH:
     * - empty/null/placeholder => set to null (CLEAR) (DO NOT delete key)
     * - valid string => set cleaned string
     */
    if (hasPatch("imageUrl")) {
      const cleaned = sanitizeImageUrl(patch.imageUrl);
      if (!cleaned || isPlaceholderUrl(cleaned)) patch.imageUrl = null;
      else patch.imageUrl = cleaned;
    }

    /**
     * Same treatment for ogImage/thumbImage if they appear in PATCH.
     */
    if (hasPatch("ogImage")) {
      const cleaned = sanitizeImageUrl(patch.ogImage);
      patch.ogImage = cleaned ? cleaned : null;
    }
    if (hasPatch("thumbImage")) {
      const cleaned = sanitizeImageUrl(patch.thumbImage);
      patch.thumbImage = cleaned ? cleaned : null;
    }

    if (hasPatch("imagePublicId")) {
      const pid = patch.imagePublicId;
      if (pid === null) {
        patch.imagePublicId = null;
      } else if (typeof pid === "string" && pid.trim() === "") {
        patch.imagePublicId = null;
      } else {
        patch.imagePublicId = String(pid).trim();
      }
    }

    const current = await Article.findById(req.params.id).lean();
    if (!current) return res.status(404).json({ error: "not_found" });

    const merged = { ...current, ...patch };

    // if default placeholder currently, treat as NO image (allow autopick)
    if (isDefaultPlaceholder(merged.imagePublicId, merged.imageUrl)) {
      merged.imagePublicId = null;
      merged.imageUrl = null;
      merged.ogImage = null;
      merged.thumbImage = null;
    }

    // Google Drive manual image -> upload to Cloudinary
    if (
      merged.imageUrl &&
      typeof merged.imageUrl === "string" &&
      merged.imageUrl.includes("drive.google.com")
    ) {
      try {
        const fileId = extractDriveFileId(merged.imageUrl);
        if (fileId) {
          const uploaded = await uploadDriveFileToCloudinary(fileId);
          if (uploaded) {
            merged.imagePublicId = uploaded.publicId;
            merged.imageUrl = uploaded.url;
            patch.imagePublicId = uploaded.publicId;
            patch.imageUrl = uploaded.url;
          }
        }
      } catch (err) {
        console.error(
          "[admin.articles] manual Drive image override failed:",
          err.message || err
        );
      }
    }

    // if manual URL provided and is Cloudinary URL -> derive publicId
    const manualUrlProvided =
      hasPatch("imageUrl") &&
      typeof patch.imageUrl === "string" &&
      patch.imageUrl.trim() !== "" &&
      !hasPatch("imagePublicId");

    if (manualUrlProvided && !merged.imagePublicId) {
      const maybePid = deriveCloudinaryPublicIdFromUrl(merged.imageUrl);
      if (maybePid) merged.imagePublicId = maybePid;
    }

    // ─────────────────────────────────────────────────────────────
    // ✅ PHASE 3 AUTO-PICK UPDATE (SAFE + PREDICTABLE)
    // Rules:
    // 1) If admin provides NON-EMPTY imageUrl/imagePublicId in this PATCH => MANUAL (never autopick)
    // 2) If admin clears imageUrl/imagePublicId (null/empty) => NOT manual; stays autopick-eligible
    // 3) If admin changes tags/category and the image was auto-picked before => re-autopick
    // 4) If there is NO real image (or only default placeholder) and admin sets tags/category => autopick
    // 5) Title/body edits alone do NOT trigger autopick
    // ─────────────────────────────────────────────────────────────

    const manualOverrideInPatch =
      (hasPatch("imageUrl") && nonEmptyStr(patch.imageUrl)) ||
      (hasPatch("imagePublicId") && nonEmptyStr(patch.imagePublicId));

    const clearingImageInPatch =
      !manualOverrideInPatch &&
      (hasPatch("imageUrl") || hasPatch("imagePublicId")) &&
      ((hasPatch("imageUrl") && !nonEmptyStr(patch.imageUrl)) ||
        (hasPatch("imagePublicId") && !nonEmptyStr(patch.imagePublicId)));

    const affectsPick =
      hasPatch("tags") || hasPatch("category") || hasPatch("categorySlug");

    const wasAutoPicked = !!current.autoImagePicked;

    const currentHasRealImage =
      (typeof current.imagePublicId === "string" &&
        current.imagePublicId.trim() &&
        !isDefaultPlaceholder(current.imagePublicId, "")) ||
      (typeof current.imageUrl === "string" &&
        current.imageUrl.trim() &&
        !isDefaultPlaceholder("", current.imageUrl));

    // If admin manually overrides image in this PATCH => lock as manual
    if (manualOverrideInPatch) {
      merged.autoImagePicked = false;
      merged.autoImagePickedAt = null;

      merged._autoImageDebug = {
        mode: "manual",
        updatedAt: new Date().toISOString(),
        imagePublicId: merged.imagePublicId || null,
        imageUrl: merged.imageUrl || null,
      };
      merged.autoImageDebug = null;
    }


    // ✅ If admin manually sets imagePublicId, force URLs to match it
if (
  manualOverrideInPatch &&
  typeof merged.imagePublicId === "string" &&
  merged.imagePublicId.trim()
) {
  merged.imageUrl = null;
  merged.ogImage = null;
  merged.thumbImage = null;
}

    // If admin is clearing image fields => ensure they are truly cleared and NOT manual
    if (clearingImageInPatch) {
      merged.imagePublicId = null;
      merged.imageUrl = null;
      merged.ogImage = null;
      merged.thumbImage = null;

      // Clearing means: not manual, and not auto-picked (until a pick happens)
      merged.autoImagePicked = false;
      merged.autoImagePickedAt = null;

      // Remove manual debug if it existed (this was the proven bug)
      merged.autoImageDebug = null;
      merged._autoImageDebug = null;
    }

    const shouldAutoPick =
      !manualOverrideInPatch &&
      affectsPick &&
      (wasAutoPicked || !currentHasRealImage);

    if (shouldAutoPick) {
      // Clear current image so decideAndAttach can choose again
      merged.imagePublicId = null;
      merged.imageUrl = null;
      merged.ogImage = null;
      merged.thumbImage = null;

      // Clear old debug so it doesn't confuse the admin
      merged.autoImageDebug = null;
      merged._autoImageDebug = null;
      merged.autoImagePicked = false;
      merged.autoImagePickedAt = null;

      await decideAndAttach(merged, {
        imageStrategy: "cloudinary",
        fallbacks: ["stock"],
      });
    }

    // Only finalize URLs if we have something (and never force defaults into DB)
    finalizeImageFields(merged);

    // Keep og/thumb in sync if imageUrl exists and og/thumb missing
    if (!merged.thumbImage && merged.imageUrl) merged.thumbImage = merged.imageUrl;
    if (!merged.ogImage && merged.imageUrl) merged.ogImage = merged.imageUrl;

    const toSaveKeys = [
      "title",
      "slug",
      "category",
      "categorySlug",
      "summary",
      "homepagePlacement",
      "imageUrl",
      "imagePublicId",
      "imageAlt",
      "status",
      "tags",
      "body",
      "bodyHtml",
      "author",
      "publishedAt",
      "ogImage",
      "thumbImage",
      "year",
      "era",
      "videoUrl",
      "videoPublicId",
      "videoSourceUrl",
      "autoImageDebug",
      "_autoImageDebug",
      "autoImagePicked",
      "autoImagePickedAt",
    ];

    const toSave = {};
    for (const k of toSaveKeys) {
      if (merged[k] !== undefined) toSave[k] = merged[k];
    }

    const updated = await Article.findByIdAndUpdate(
      req.params.id,
      { $set: toSave },
      { new: true }
    )
      .populate({
        path: "category",
        select: "name slug",
        options: { lean: true },
      })
      .lean();

    if (!updated) return res.status(404).json({ error: "not_found" });

    const items = normalizeArticlesWithCategories([updated]);
    const a = items[0];

    const cleanedUrl = sanitizeImageUrl(a.imageUrl);
    const bestPid = a.imagePublicId || DEFAULT_PID;
    a.imageUrl =
      cleanedUrl || (bestPid && CLOUD_NAME ? buildCloudinaryUrl(bestPid) : "");

    a.category = toCatText(a.category);
    a.categories = Array.isArray(a.categories) ? a.categories.map(toCatText) : [];
    a.autoImageDebug = a.autoImageDebug || a._autoImageDebug || null;

    res.json(a);
  } catch (err) {
    console.error("[admin.articles] patch error", err);
    res.status(500).json({ error: "failed_to_update_article" });
  }
});

// SET DEFAULT IMAGE — POST /api/admin/articles/:id/use-default-image
router.post("/:id/use-default-image", async (req, res) => {
  try {
    const { id } = req.params;

    if (!DEFAULT_PID || !CLOUD_NAME) {
      return res.status(500).json({
        ok: false,
        error: "no_default_image_configured",
      });
    }

    const article = await Article.findById(id);
    if (!article) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    article.imagePublicId = DEFAULT_PID;
    article.imageUrl = null;
    article.ogImage = null;
    article.thumbImage = null;

    finalizeImageFields(article);

    await article.save();

    return res.json({
      ok: true,
      imagePublicId: article.imagePublicId,
      imageUrl: article.imageUrl,
      ogImage: article.ogImage,
      thumbImage: article.thumbImage,
    });
  } catch (err) {
    console.error("[admin.articles] use-default-image error:", err);
    return res
      .status(500)
      .json({ ok: false, error: String(err.message || err) });
  }
});

// PUBLISH — POST /api/admin/articles/:id/publish
router.post("/:id/publish", async (req, res) => {
  try {
    const updated = await Article.findByIdAndUpdate(
      req.params.id,
      { $set: { status: "published", publishedAt: new Date() } },
      { new: true }
    )
      .populate({
        path: "category",
        select: "name slug",
        options: { lean: true },
      })
      .lean();

    if (!updated) return res.status(404).json({ error: "not_found" });

    const items = normalizeArticlesWithCategories([updated]);
    const a = items[0];

    const cleanedUrl = sanitizeImageUrl(a.imageUrl);
    const bestPid = a.imagePublicId || DEFAULT_PID;
    a.imageUrl =
      cleanedUrl || (bestPid && CLOUD_NAME ? buildCloudinaryUrl(bestPid) : "");

    a.category = toCatText(a.category);
    a.categories = Array.isArray(a.categories)
      ? a.categories.map(toCatText)
      : [];
    a.autoImageDebug = a.autoImageDebug || a._autoImageDebug || null;

    res.json(a);

    try {
      const { publishEverywhere } = require("../services/socialPublisher");
      Promise.resolve()
        .then(() => publishEverywhere(updated))
        .catch(() => {});
    } catch (_) {}
  } catch (err) {
    console.error("[admin.articles] publish error", err);
    res.status(500).json({ error: "failed_to_publish" });
  }
});

// AI IMAGE — POST /api/admin/articles/:id/ai-image
router.post("/:id/ai-image", async (req, res) => {
  try {
    if (process.env.AI_IMAGE_ENABLED === "false") {
      return res.status(403).json({
        ok: false,
        error: "ai_image_disabled",
      });
    }

    const { id } = req.params;
    const result = await generateAiHeroForArticle(id);

    if (!result) {
      return res.status(404).json({
        ok: false,
        error: "ai_image_failed",
      });
    }

    return res.json({
      ok: true,
      articleId: result.articleId || id,
      imageUrl: result.imageUrl,
      imagePublicId: result.imagePublicId,
      ogImage: result.ogImage,
      thumbImage: result.thumbImage,
    });
  } catch (err) {
    console.error("[admin.articles] /:id/ai-image error", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "ai_image_failed",
    });
  }
});

module.exports = router;
