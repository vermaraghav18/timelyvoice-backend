// backend/src/services/finalizeArticleImages.js
// Ensures an article has imagePublicId, imageUrl, ogImage, thumbImage, imageAlt.
// Uses chooseHeroImage() to pick a best-fit Cloudinary image (or fallback).

const { v2: cloudinary } = require("cloudinary");
const { chooseHeroImage } = require("./imagePicker");

const OG_W = 1200;
const OG_H = 630;

const DEFAULT_PUBLIC_ID =
  process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID ||
  process.env.AUTOMATION_DEFAULT_IMAGE_ID ||
  "news-images/default-hero";

(function ensureCloudinaryConfigured() {
  const cfg = cloudinary.config();
  if (!cfg.cloud_name) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }
})();

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

/**
 * finalizeArticleImages(articleLike)
 * articleLike: { title, summary, category, tags, slug, imageUrl, imagePublicId, ogImage, thumbImage, imageAlt }
 * Returns an object with finalized fields.
 */
async function finalizeArticleImages(articleLike = {}) {
  // Normalize empties
  const norm = { ...articleLike };
  if (norm.imageUrl === "") norm.imageUrl = null;
  if (norm.imagePublicId === "") norm.imagePublicId = null;
  if (norm.ogImage === "") norm.ogImage = null;
  if (norm.thumbImage === "") norm.thumbImage = null;

  let imagePublicId = norm.imagePublicId || null;
  let imageUrl = norm.imageUrl || null;

  // If both missing → pick one (or fallback) using the article metadata
  if (!imagePublicId && !imageUrl) {
    const pick = await chooseHeroImage({
      title: norm.title,
      summary: norm.summary,
      category: norm.category,
      tags: norm.tags,
      slug: norm.slug,
    });
    imagePublicId = pick.publicId || DEFAULT_PUBLIC_ID;
    imageUrl = pick.url || buildHeroUrl(imagePublicId);
  }

  // If we have publicId but no URL → build hero
  if (imagePublicId && !imageUrl) {
    imageUrl = buildHeroUrl(imagePublicId);
  }

  // If we still have nothing (extreme edge) → defaults
  if (!imagePublicId) imagePublicId = DEFAULT_PUBLIC_ID;
  if (!imageUrl) imageUrl = buildHeroUrl(imagePublicId);

  // Always build og/thumb
  const ogImage = buildOgUrl(imagePublicId);
  const thumbImage = buildThumbUrl(imagePublicId);

  const imageAlt = norm.imageAlt || norm.title || "News image";

  return { imagePublicId, imageUrl, ogImage, thumbImage, imageAlt };
}

module.exports = { finalizeArticleImages };
