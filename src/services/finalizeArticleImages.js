// backend/src/services/finalizeArticleImages.js
// Cloudinary-only image finalizer (FINAL, FIXED)
//
// PURPOSE:
//  - Respect manual images
//  - Upload Drive images if pasted manually
//  - Auto-pick from Cloudinary ONLY when no real image exists
//  - NEVER block picker because of default placeholder
//

const {
  uploadDriveImageToCloudinary,
  extractDriveFileId,
} = require("./googleDriveUploader");
const { chooseHeroImage } = require("./imagePicker");
const cloudinary = require("cloudinary").v2;

// OG variants
const OG_W = Number(process.env.CLOUDINARY_OG_WIDTH || 1200);
const OG_H = Number(process.env.CLOUDINARY_OG_HEIGHT || 630);

// Default Cloudinary placeholder
const DEFAULT_PUBLIC_ID =
  process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID ||
  "news-images/defaults/fallback-hero";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function buildHeroUrl(publicId) {
  return cloudinary.url(publicId, {
    type: "upload",
    transformation: [
      { width: OG_W, height: OG_H, crop: "fill", gravity: "auto" },
      { fetch_format: "jpg", quality: "auto" },
    ],
    secure: true,
  });
}

function buildOgUrl(publicId) {
  return cloudinary.url(publicId, {
    width: OG_W,
    height: OG_H,
    crop: "fill",
    gravity: "auto",
    format: "jpg",
    secure: true,
  });
}

function buildThumbUrl(publicId) {
  return cloudinary.url(publicId, {
    width: 400,
    height: 300,
    crop: "fill",
    gravity: "auto",
    format: "webp",
    secure: true,
  });
}

function looksLikeGoogleDrive(url = "") {
  return (
    typeof url === "string" &&
    (url.includes("drive.google.com") || url.includes("googleusercontent"))
  );
}

function normalize(a = {}) {
  const obj = { ...a };
  if (obj.imageUrl === "") obj.imageUrl = null;
  if (obj.imagePublicId === "") obj.imagePublicId = null;
  if (obj.ogImage === "") obj.ogImage = null;
  if (obj.thumbImage === "") obj.thumbImage = null;
  return obj;
}

// 🔥 CRITICAL: default placeholder ≠ real image
function isDefaultPlaceholder(publicId, imageUrl) {
  return (
    (typeof publicId === "string" &&
      (publicId.includes("/defaults/") ||
        publicId.includes("news-images/default"))) ||
    (typeof imageUrl === "string" && imageUrl.includes("news-images/default"))
  );
}

// OPTIONAL but recommended: derive PID from a Cloudinary URL if PID missing
function deriveCloudinaryPublicIdFromUrl(url = "") {
  if (typeof url !== "string" || !url.includes("/image/upload/")) return null;
  try {
    // Example:
    // https://res.cloudinary.com/<cloud>/image/upload/c_fill,w_800/v1723456/folder/name/file.jpg
    const afterUpload = url.split("/image/upload/")[1];
    if (!afterUpload) return null;

    const clean = afterUpload.split(/[?#]/)[0]; // strip query/hash
    const segs = clean.split("/");

    let i = 0;
    // skip transformation segments (contain commas or colon)
    while (i < segs.length && (segs[i].includes(",") || segs[i].includes(":")))
      i++;
    // skip version like v12345
    if (i < segs.length && /^v\d+$/i.test(segs[i])) i++;

    const publicPath = segs.slice(i).join("/");
    if (!publicPath) return null;

    return publicPath.replace(/\.[a-z0-9]+$/i, "") || null; // drop extension
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// MAIN FINALIZER
// -----------------------------------------------------------------------------
exports.finalizeArticleImages = async function finalizeArticleImages(
  articleLike = {}
) {
  const norm = normalize(articleLike);

  let imagePublicId = norm.imagePublicId || null;
  let imageUrl = norm.imageUrl || null;

  let autoImageDebug = norm.autoImageDebug || null;
  let autoPicked = false;

  // ---------------------------------------------------------------------------
  // 🔥 ALLOW AUTOPICK IF CURRENT IMAGE IS JUST DEFAULT PLACEHOLDER
  // ---------------------------------------------------------------------------
  if (isDefaultPlaceholder(imagePublicId, imageUrl)) {
    imagePublicId = null;
    imageUrl = null;
  }

  // ---------------------------------------------------------------------------
  // ✅ CONSISTENCY: If Cloudinary URL exists but PID missing, derive it.
  // (Prevents treating Cloudinary as "external manual" by mistake.)
  // ---------------------------------------------------------------------------
  if (!imagePublicId && imageUrl && String(imageUrl).includes("/image/upload/")) {
    const pid = deriveCloudinaryPublicIdFromUrl(String(imageUrl));
    if (pid) imagePublicId = pid;
  }

  // ---------------------------------------------------------------------------
  // CASE 1 — Manual external image (non-Drive)
  // ---------------------------------------------------------------------------
  if (imageUrl && !imagePublicId && !looksLikeGoogleDrive(imageUrl)) {
    // Manual external URL = respect it fully (do NOT force default PID)
    return {
      imagePublicId: null,
      imageUrl,
      ogImage: norm.ogImage || imageUrl,
      thumbImage: norm.thumbImage || imageUrl,
      imageAlt: norm.imageAlt || norm.title || "News image",
      autoImageDebug: {
        mode: "manual-external-url",
        picked: imageUrl,
      },
      autoImagePicked: false,
      autoImagePickedAt: null,
    };
  }

  // ---------------------------------------------------------------------------
  // CASE 2 — Manual Google Drive URL → upload
  // ---------------------------------------------------------------------------
  if (imageUrl && looksLikeGoogleDrive(imageUrl) && !imagePublicId) {
    try {
      const fileId = extractDriveFileId(imageUrl);
      if (!fileId) throw new Error("Invalid Drive URL");

      const upload = await uploadDriveImageToCloudinary(fileId, {
        folder: process.env.CLOUDINARY_FOLDER || "news-images",
      });

      imagePublicId = upload.public_id;
      imageUrl = buildHeroUrl(upload.public_id);

      autoImageDebug = {
        mode: "manual-drive-upload",
        picked: upload.public_id,
      };
    } catch (err) {
      // Keep the reason for debugging, but allow fallback logic to continue
      imagePublicId = null;
      imageUrl = null;
      autoImageDebug = {
        mode: "manual-drive-upload-failed",
        error: String(err?.message || err),
      };
    }
  }

  // ---------------------------------------------------------------------------
// CASE 3 — NOTHING EXISTS → AUTO PICK (ImageLibrary / Cloudinary)
// ---------------------------------------------------------------------------
if (!imagePublicId && !imageUrl) {
  try {
    const pick = await chooseHeroImage({
      title: norm.title,
      summary: norm.summary,
      category: norm.category,
      tags: norm.tags,
      slug: norm.slug,
    });

    if (pick && pick.publicId) {
      imagePublicId = pick.publicId;
      imageUrl = pick.url || buildHeroUrl(pick.publicId);

      // ✅ FIX: Always mark ImagePicker selection as AUTO (not manual)
      autoPicked = true;

      // ✅ FIX: overwrite any "manual" mode coming from pick.why
      autoImageDebug = {
        ...(pick.why && typeof pick.why === "object" ? pick.why : {}),
        mode: "auto-image-library",
        picked: pick.publicId,
        pickedFrom: "image-library",
        updatedAt: new Date().toISOString(),
      };
    }
  } catch (e) {
    // swallow → fallback below
  }
}


  // ---------------------------------------------------------------------------
  // FINAL FALLBACK — ONLY IF NOTHING WORKED
  // ---------------------------------------------------------------------------
  if (!imagePublicId) imagePublicId = DEFAULT_PUBLIC_ID;
  if (!imageUrl) imageUrl = buildHeroUrl(imagePublicId);

  const ogImage = buildOgUrl(imagePublicId);
  const thumbImage = buildThumbUrl(imagePublicId);

 if (!autoImageDebug) {
  autoImageDebug = {
    mode: autoPicked
      ? "auto-image-library"
      : imagePublicId === DEFAULT_PUBLIC_ID
      ? "fallback-default"
      : "kept-existing",
    picked: imagePublicId,
    pickedFrom: autoPicked ? "image-library" : undefined,
    updatedAt: new Date().toISOString(),
  };
}

  return {
    imagePublicId,
    imageUrl,
    ogImage,
    thumbImage,
    imageAlt: norm.imageAlt || norm.title || "News image",
    autoImageDebug,
    autoImagePicked: autoPicked,
    autoImagePickedAt: autoPicked ? new Date() : null,
  };
};
