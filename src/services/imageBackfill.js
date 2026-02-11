// backend/src/services/imageBackfill.js
"use strict";

const Article = require("../models/Article");
const cloudinary = require("cloudinary").v2;

const OG_W = Number(process.env.CLOUDINARY_OG_WIDTH || 1200);
const OG_H = Number(process.env.CLOUDINARY_OG_HEIGHT || 630);

const DEFAULT_PUBLIC_ID =
  process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID ||
  "news-images/defaults/fallback-hero";

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

function normalizeTag(t) {
  return String(t || "").trim().toLowerCase();
}

function isDefaultImagePublicId(pid = "") {
  const s = String(pid || "");
  return !s || s === DEFAULT_PUBLIC_ID || s.includes("/defaults/");
}

function overlapCount(aTags = [], bTags = []) {
  const A = new Set(aTags.map(normalizeTag).filter(Boolean));
  let c = 0;
  for (const t of bTags.map(normalizeTag).filter(Boolean)) {
    if (A.has(t)) c += 1;
  }
  return c;
}

/**
 * Backfill logic:
 * - Only update articles that are still using DEFAULT / defaults/* OR have no image
 * - Only update drafts (safe)
 * - Only update AI-created articles by default (safe)
 * - Apply if:
 *    - tag overlap >= 1 (excluding "default" tag)
 *    - AND category matches (if library image has category and not global)
 */
async function backfillMatchingArticlesFromLibraryImage(imageDoc, opts = {}) {
  const {
    limit = 200,
    lookbackHours = 168, // 7 days
    onlyAi = true,
  } = opts;

  if (!imageDoc?.publicId) {
    return { ok: false, error: "missing_publicId" };
  }

  const imgTags = Array.isArray(imageDoc.tags) ? imageDoc.tags : [];
  const imgTagsNoDefault = imgTags.filter((t) => normalizeTag(t) !== "default");
  const imgCategory = String(imageDoc.category || "").trim().toLowerCase();

  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

  const baseQuery = {
    status: "draft",
    updatedAt: { $gte: since },
    $or: [
      { imagePublicId: { $exists: false } },
      { imagePublicId: null },
      { imagePublicId: "" },
      { imagePublicId: DEFAULT_PUBLIC_ID },
      { imagePublicId: { $regex: "/defaults/" } },
    ],
  };

  if (onlyAi) {
    baseQuery.source = { $in: ["ai-batch", "ai-news", "ai"] }; // keep loose, safe
  }

  // If this library image is tagged "default" -> backfill only default-image articles (already filtered above)
  // If not default -> match by tags and/or category
 // IMPORTANT: Do NOT filter by tags in Mongo because tags are case-sensitive in DB.
// We'll do the tag overlap match in JS using normalizeTag() so it works for "Ice" vs "ice".
 else {
    // If it’s only a default tag, don’t require article tags match.
    // We still only update default-image articles.
  }

  // If image has a real category (not global/all), require category match
  if (imgCategory && imgCategory !== "global" && imgCategory !== "all") {
    baseQuery.category = new RegExp(`^${imgCategory}$`, "i");
  }

  const candidates = await Article.find(baseQuery)
    .sort({ updatedAt: -1 })
    .limit(Math.max(1, Math.min(Number(limit) || 200, 1000)))
    .lean();

  let updated = 0;
  const updatedIds = [];

  for (const a of candidates) {
    const artTags = Array.isArray(a.tags) ? a.tags : [];
    const matchCount = imgTagsNoDefault.length
      ? overlapCount(artTags, imgTagsNoDefault)
      : 0;

    // For non-default images, require at least 1 matching tag
    if (imgTagsNoDefault.length && matchCount < 1) continue;

    // Don’t touch if article already has a non-default image (double safety)
    if (!isDefaultImagePublicId(a.imagePublicId)) continue;

    const heroUrl = imageDoc.url ? String(imageDoc.url).replace(/\s+/g, "") : "";
    const finalHero = heroUrl || buildHeroUrl(imageDoc.publicId);

    // Update
    const res = await Article.updateOne(
      { _id: a._id },
      {
        $set: {
          imagePublicId: imageDoc.publicId,
          imageUrl: finalHero,
          ogImage: buildOgUrl(imageDoc.publicId),
          thumbImage: buildThumbUrl(imageDoc.publicId),

          autoImagePicked: true,
          autoImagePickedAt: new Date(),

          _autoImageDebug: {
            mode: "backfill-from-image-library",
            imageLibraryId: String(imageDoc._id),
            picked: imageDoc.publicId,
            matchedTags: imgTagsNoDefault.length ? imgTagsNoDefault : ["default"],
            matchCount,
            updatedAt: new Date().toISOString(),
          },
        },
      }
    );

    if (res?.modifiedCount) {
      updated += 1;
      updatedIds.push(String(a._id));
    }
  }

  return {
    ok: true,
    scanned: candidates.length,
    updated,
    updatedIds,
    imagePublicId: imageDoc.publicId,
    usedTags: imgTagsNoDefault.length ? imgTagsNoDefault : ["default"],
    category: imageDoc.category || "",
  };
}

module.exports = {
  backfillMatchingArticlesFromLibraryImage,
};
