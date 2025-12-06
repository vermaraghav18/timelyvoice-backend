// STEP 1: Image strategy orchestrator (Cloudinary-first)
// File: backend/src/services/imageStrategy.js
// Purpose: If an incoming article lacks imageUrl/imagePublicId, attach one automatically
// using Google Drive → Cloudinary picker. Fallback uses a default Cloudinary image.

const cloudinary = require("cloudinary").v2;
const assert = require("assert");
const { chooseHeroImage } = require("./imagePicker");

const DEFAULT_PUBLIC_ID = process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID || "";

// Helpers to detect placeholders
const PLACEHOLDER_HOSTS = ["example.com", "cdn.example", "your-cdn.example"];

function isPlaceholderUrl(url = "") {
  if (!url) return true;
  try {
    const u = new URL(url);
    return PLACEHOLDER_HOSTS.some((h) => u.hostname.includes(h));
  } catch (_) {
    return false;
  }
}

function normalizeArticleInput(a = {}) {
  return {
    title: a.title || "",
    summary: a.summary || "",
    slug: a.slug || "",
    category: a.category || "",
    tags: Array.isArray(a.tags) ? a.tags : [],
    imageAlt: a.imageAlt || "",
  };
}

/**
 * Main orchestrator.
 * Mutates `article` in-place:
 *  - prefers existing non-placeholder imagePublicId / imageUrl
 *  - else tries Google Drive picker (chooseHeroImage)
 *  - else falls back to default Cloudinary image
 */
async function decideAndAttach(article = {}, opts = {}) {
  assert(article, "article is required");
  const meta = normalizeArticleInput(article);

  // 1) Respect existing real images
  if (article.imagePublicId && article.imagePublicId !== DEFAULT_PUBLIC_ID) {
    return "kept-existing-public-id";
  }
  if (article.imageUrl && !isPlaceholderUrl(article.imageUrl)) {
    return "kept-existing-url";
  }

  // 2) Try Google Drive → Cloudinary picker
  let picked = null;
  try {
    picked = await chooseHeroImage({
      title: meta.title,
      summary: meta.summary,
      slug: meta.slug,
      category: meta.category,
      tags: meta.tags,
      imageAlt: meta.imageAlt,
    });
  } catch (err) {
    console.error("[imageStrategy] chooseHeroImage error:", err);
    picked = null;
  }

  if (picked && picked.publicId) {
    article.imagePublicId = picked.publicId;
    article.imageUrl = picked.url || cloudinary.url(picked.publicId);
    if (!article.imageAlt) {
      article.imageAlt = meta.imageAlt || meta.title || "News image";
    }
    return "attached-drive-image";
  }

  // 3) Fallback: default image (only if no Drive pick & no existing image)
  if (!article.imagePublicId && DEFAULT_PUBLIC_ID) {
    article.imagePublicId = DEFAULT_PUBLIC_ID;
    article.imageUrl = cloudinary.url(DEFAULT_PUBLIC_ID);
    if (!article.imageAlt) {
      article.imageAlt = meta.title || "News image";
    }
    return "attached-default-image";
  }

  return "no-change";
}

module.exports = {
  decideAndAttach,
};
