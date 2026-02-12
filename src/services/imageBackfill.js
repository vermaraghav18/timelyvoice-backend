// backend/src/services/imageBackfill.js
"use strict";

const Article = require("../models/Article");
const cloudinary = require("cloudinary").v2;

const OG_W = Number(process.env.CLOUDINARY_OG_WIDTH || 1200);
const OG_H = Number(process.env.CLOUDINARY_OG_HEIGHT || 630);

const DEFAULT_PUBLIC_ID =
  process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID ||
  "news-images/defaults/fallback-hero";

// ✅ This is the IMPORTANT one you set in Render.
// We now actually use it here (previously it was ignored).
const REQUIRED_STRONG_MATCHES = Math.max(
  1,
  Number(process.env.IMAGE_LIBRARY_REQUIRED_STRONG_MATCHES || 1)
);

// ✅ Tags that are too broad should NOT count as “strong” matches.
// (This is what caused “canada” to wrongly pick a cricket image.)
const GENERIC_TAGS = new Set(
  [
    // very generic
    "default",
    "news",
    "breaking",
    "trending",
    "viral",
    "today",
    "latest",
    "update",
    "headline",
    "report",
    "alert",
    "live",

    // categories / broad
    "world",
    "india",
    "general",
    "politics",
    "business",
    "finance",
    "health",
    "sports",
    "entertainment",
    "tech",
    "technology",
    "crime",

    // broad location / country words (too broad to decide an image)
    "canada",
    "usa",
    "us",
    "unitedstates",
    "united-states",
    "uk",
    "uae",
    "newzealand",
    "new-zealand",
    "australia",
    "china",
    "russia",
    "iran",
    "israel",
    "pakistan",
    "afghanistan",
    "srilanka",
    "sri-lanka",
    "japan",
    "france",
    "germany",
    "italy",
    "spain",
    "qatar",
    "turkey",
    "ukraine",
    "saudi",
    "saudiarabia",
    "saudi-arabia",

    // common filler tags people add
    "official",
    "statement",
    "minister",
    "government",
    "agency",
    "team",
    "match",
    "tournament",
  ].map((t) => String(t).trim().toLowerCase())
);

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

function isGenericTag(t) {
  const x = normalizeTag(t);
  return !x || GENERIC_TAGS.has(x);
}

/**
 * ✅ Strong overlap:
 * - Only counts matches that are NOT generic (so "canada" won't count)
 * - Excludes "default"
 * - Returns real matched tags (for correct debug)
 */
function strongOverlap(articleTags = [], imageTags = []) {
  const A = new Set(
    articleTags
      .map(normalizeTag)
      .filter((t) => t && t !== "default" && !isGenericTag(t))
  );

  const matched = [];
  for (const raw of imageTags) {
    const t = normalizeTag(raw);
    if (!t || t === "default" || isGenericTag(t)) continue;
    if (A.has(t)) matched.push(t);
  }

  // remove duplicates
  const unique = Array.from(new Set(matched));
  return { strongMatchCount: unique.length, matchedStrongTags: unique };
}

/**
 * Backfill logic (FIXED):
 * - Only update articles that are still using DEFAULT / defaults/* OR have no image
 * - Only update drafts (safe)
 * - Only update AI-created articles by default (safe)
 * - Apply if:
 *    - strong tag overlap >= REQUIRED_STRONG_MATCHES
 *      (strong = NOT generic; so "canada" alone won't count)
 *    - AND category matches (if library image has category and not global)
 */
async function backfillMatchingArticlesFromLibraryImage(imageDoc, opts = {}) {
  const { limit = 200, lookbackHours = 168, onlyAi = true } = opts;

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
    baseQuery.source = { $in: ["ai-batch", "ai-news", "ai"] };
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
    // Double safety: don’t touch if article already has a non-default image
    if (!isDefaultImagePublicId(a.imagePublicId)) continue;

    const artTags = Array.isArray(a.tags) ? a.tags : [];

    // ✅ If the library image is basically "default" (no real tags),
    // we allow it to fill default-image articles without tag matching.
    // Otherwise, require strong tag overlap >= REQUIRED_STRONG_MATCHES.
    let strongMatchCount = 0;
    let matchedStrongTags = [];

    if (imgTagsNoDefault.length) {
      const res = strongOverlap(artTags, imgTagsNoDefault);
      strongMatchCount = res.strongMatchCount;
      matchedStrongTags = res.matchedStrongTags;

      if (strongMatchCount < REQUIRED_STRONG_MATCHES) continue;
    }

    const heroUrl = imageDoc.url ? String(imageDoc.url).replace(/\s+/g, "") : "";
    const finalHero = heroUrl || buildHeroUrl(imageDoc.publicId);

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

            // ✅ show the REAL matched tags (not “all image tags”)
            matchedTags: matchedStrongTags.length
              ? matchedStrongTags
              : imgTagsNoDefault.length
              ? ["not-enough-strong-matches"]
              : ["default"],

            matchCount: strongMatchCount,
            requiredStrongMatches: REQUIRED_STRONG_MATCHES,

            // helpful extra info for troubleshooting
            imageTags: imgTagsNoDefault.length ? imgTagsNoDefault : ["default"],
            articleTags: Array.isArray(artTags) ? artTags : [],

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
    requiredStrongMatches: REQUIRED_STRONG_MATCHES,
  };
}

module.exports = {
  backfillMatchingArticlesFromLibraryImage,
};
