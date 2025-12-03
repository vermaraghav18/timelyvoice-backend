// backend/src/services/finalizeArticleImages.js
// Google-Drive → Cloudinary hybrid image finalizer
//
// PURPOSE:
//  - If article already has imageUrl → keep it (manual override)
//  - If article only has Google Drive imageUrl → upload to Cloudinary
//  - If article has NOTHING → auto-pick from Drive (imagePicker, which already uploads to Cloudinary)
//  - Always build OG, hero, thumb URLs from Cloudinary
//

const { uploadDriveImageToCloudinary, extractDriveFileId } = require("./googleDriveUploader");
const { chooseHeroImage } = require("./imagePicker"); // now returns Cloudinary publicId + url
const cloudinary = require("cloudinary").v2;

// OG variants
const OG_W = 1200;
const OG_H = 630;

// Default Cloudinary image
const DEFAULT_PUBLIC_ID =
  process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID ||
  "news-images/defaults/fallback-hero";

// Build Cloudinary variants
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

// Detect if URL is a Google Drive direct file link
function looksLikeGoogleDrive(url = "") {
  return (
    typeof url === "string" &&
    (url.includes("drive.google.com") || url.includes("googleusercontent"))
  );
}

// Normalize empty image fields on incoming article
function normalize(a = {}) {
  const obj = { ...a };
  if (obj.imageUrl === "") obj.imageUrl = null;
  if (obj.imagePublicId === "") obj.imagePublicId = null;
  if (obj.ogImage === "") obj.ogImage = null;
  if (obj.thumbImage === "") obj.thumbImage = null;
  return obj;
}

/**
 * finalizeArticleImages(articleLike)
 * Ensures Cloudinary publicId + hero + og + thumb are always available.
 *
 * LOGIC:
 * 1) If manual imageUrl provided AND it's not Drive → we keep it.
 * 2) If imageUrl is a Drive URL → upload to Cloudinary then build variants.
 * 3) If no imageUrl and no publicId → auto-pick from Google Drive (imagePicker),
 *    which already uploads to Cloudinary and returns { publicId, url }.
 * 4) Always generate OG + thumb from Cloudinary.
 */
exports.finalizeArticleImages = async function finalizeArticleImages(articleLike = {}) {
  const norm = normalize(articleLike);

  let imagePublicId = norm.imagePublicId || null;
  let imageUrl = norm.imageUrl || null;

  // ───────────────────────────────────────────────────────────
  // CASE 1 — Manual CDN/HTTP image (NOT Drive) → keep as-is
  // ───────────────────────────────────────────────────────────
  if (imageUrl && !imagePublicId && !looksLikeGoogleDrive(imageUrl)) {
    // Build OG + thumb from DEFAULT_PUBLIC_ID for consistency
    return {
      imagePublicId: DEFAULT_PUBLIC_ID,
      imageUrl,
      ogImage: buildOgUrl(DEFAULT_PUBLIC_ID),
      thumbImage: buildThumbUrl(DEFAULT_PUBLIC_ID),
      imageAlt: norm.imageAlt || norm.title || "News image",
    };
  }

  // ───────────────────────────────────────────────────────────
  // CASE 2 — Manual Google Drive URL → upload to Cloudinary (by fileId)
  // ───────────────────────────────────────────────────────────
  if (imageUrl && looksLikeGoogleDrive(imageUrl) && !imagePublicId) {
    try {
      const fileId = extractDriveFileId(imageUrl);
      if (fileId) {
        const upload = await uploadDriveImageToCloudinary(fileId, {
          folder: process.env.CLOUDINARY_FOLDER || "news-images",
        });
        imagePublicId = upload.public_id;
        imageUrl = buildHeroUrl(upload.public_id);
      } else {
        console.error("[finalizeArticleImages] Could not extract Drive fileId from URL");
        imagePublicId = DEFAULT_PUBLIC_ID;
        imageUrl = buildHeroUrl(DEFAULT_PUBLIC_ID);
      }
    } catch (e) {
      console.error("[finalizeArticleImages] Drive upload failed:", e);
      imagePublicId = DEFAULT_PUBLIC_ID;
      imageUrl = buildHeroUrl(DEFAULT_PUBLIC_ID);
    }
  }

  // ───────────────────────────────────────────────────────────
  // CASE 3 — No image fields at all → auto-pick via imagePicker
  // (imagePicker already does Drive → Cloudinary and returns { publicId, url })
  // ───────────────────────────────────────────────────────────
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
      } else {
        console.warn("[finalizeArticleImages] chooseHeroImage returned no pick, using default");
        imagePublicId = DEFAULT_PUBLIC_ID;
        imageUrl = buildHeroUrl(DEFAULT_PUBLIC_ID);
      }
    } catch (e) {
      console.error("[auto-pick] chooseHeroImage failed:", e);
      imagePublicId = DEFAULT_PUBLIC_ID;
      imageUrl = buildHeroUrl(DEFAULT_PUBLIC_ID);
    }
  }

  // ───────────────────────────────────────────────────────────
  // FINAL SAFETY CHECK + ALWAYS BUILD VARIANTS
  // ───────────────────────────────────────────────────────────
  if (!imagePublicId) imagePublicId = DEFAULT_PUBLIC_ID;
  if (!imageUrl) imageUrl = buildHeroUrl(imagePublicId);

  const ogImage = buildOgUrl(imagePublicId);
  const thumbImage = buildThumbUrl(imagePublicId);

  return {
    imagePublicId,
    imageUrl,
    ogImage,
    thumbImage,
    imageAlt: norm.imageAlt || norm.title || "News image",
  };
};
