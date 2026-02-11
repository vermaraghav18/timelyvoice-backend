// backend/src/services/imageStrategy.js
// Image Strategy Orchestrator (IMAGE-LIBRARY ONLY)
//
// PURPOSE (your requirement):
// - Created-by-AI (and all autopick) must ONLY use /admin/image-library
// - If tags match -> pick best match
// - Else if category match -> pick category match
// - Else -> pick ImageLibrary image tagged "default" (ONE canonical default)
// - Only if ImageLibrary is empty -> use DEFAULT_PUBLIC_ID fallback (env)
// - NEVER use Cloudinary tag-search picker (chooseHeroImage)

"use strict";

const cloudinary = require("cloudinary").v2;
const assert = require("assert");
const ImageLibrary = require("../models/ImageLibrary");

const DEFAULT_PUBLIC_ID =
  process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID ||
  "news-images/defaults/fallback-hero";

const IMAGE_LIBRARY_CANDIDATE_LIMIT = parseInt(
  process.env.IMAGE_LIBRARY_CANDIDATE_LIMIT || "300",
  10
);

// ✅ NEW: require at least N "strong" (non-generic) matches for tag-pick to be valid
const IMAGE_LIBRARY_REQUIRED_STRONG_MATCHES = parseInt(
  process.env.IMAGE_LIBRARY_REQUIRED_STRONG_MATCHES || "1",
  10
);

// ✅ NEW: generic tags are too broad; they should NOT drive picking
const GENERIC_TAGS = new Set([
  "india",
  "world",
  "general",
  "news",
  "politic",
  "politics",
  "trending",
  "viral",
  "update",
  "breaking",
  "today",
  "latest",
  "report",
  "headline",
  "story",
  "international",
  "national",
  "state",
  "government",
  "govt",
  "election",
  "crime",
  "sport",
  "sports",
  "finance",
  "business",
  "economy",
  "health",
  "technology",
  "tech",
  "entertainment",
]);

function isGenericTag(t) {
  return GENERIC_TAGS.has(String(t || "").trim().toLowerCase());
}

// Placeholder hosts for junk URLs pasted in drafts
const PLACEHOLDER_HOSTS = ["example.com", "cdn.example", "your-cdn.example"];

function isPlaceholderUrl(url = "") {
  if (!url) return true;
  try {
    const u = new URL(url);
    const h = (u.hostname || "").toLowerCase();
    return (
      PLACEHOLDER_HOSTS.some((x) => h.includes(x)) ||
      h.endsWith(".example") ||
      h.includes("cdn.example")
    );
  } catch (_) {
    return false;
  }
}

// 🔥 Default placeholder is NOT a real image
function isDefaultPlaceholder(publicId, imageUrl) {
  return (
    (typeof publicId === "string" &&
      (publicId.includes("/defaults/") ||
        publicId.includes("news-images/default"))) ||
    (typeof imageUrl === "string" && imageUrl.includes("news-images/default"))
  );
}

// ------------------------------
// Tag normalization (keep same as before)
// ------------------------------
function stem(t) {
  if (!t) return "";
  if (t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.endsWith("s") && t.length > 3) return t.slice(0, -1);
  return t;
}

function normalizeTag(raw = "") {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  const noHash = s.replace(/^#+/g, "");
  const clean = noHash.replace(/[^a-z0-9_-]/g, "");
  return clean;
}

function normStemTag(raw = "") {
  return stem(normalizeTag(raw));
}

function dedupe(arr) {
  return Array.from(new Set(arr));
}

function normalizeTagsInput(tags) {
  if (!tags) return [];
  if (typeof tags === "string") {
    return tags
      .split(/[,|]/g)
      .map((x) => x.trim())
      .filter(Boolean)
      .map(normStemTag)
      .filter(Boolean);
  }
  if (Array.isArray(tags)) {
    return tags
      .map((x) => {
        if (typeof x === "string") return x;
        if (x && typeof x === "object")
          return x.value || x.label || x.name || "";
        return "";
      })
      .map(normStemTag)
      .filter(Boolean);
  }
  return [];
}

function normalizeCategory(raw = "") {
  // categories can be "Politics", "world", "New Delhi", "new-delhi"
  // normalize to a stable slug-like token so comparisons are consistent
  return normStemTag(raw);
}

function normalizeArticleInput(a = {}) {
  return {
    title: a.title || "",
    summary: a.summary || "",
    slug: a.slug || "",
    category: String(a.category || "").trim(),
    tags: dedupe(normalizeTagsInput(a.tags)),
    imageAlt: a.imageAlt || "",
  };
}

// ------------------------------
// DEFAULT PICKER (ImageLibrary)
// RULE: Image must have tag "default"
// Preference order:
// 1) category-specific default (category = article category)
// 2) global default (category = "global")
// 3) any default (tag-only)
// ------------------------------
async function pickDefaultFromImageLibrary({ category = "" } = {}) {
  const cleanCategoryRaw = String(category || "").trim();
  const cleanCategory = normalizeCategory(cleanCategoryRaw);

  // 1) category-specific default
  let doc = null;
  if (cleanCategory) {
    doc = await ImageLibrary.findOne({
      category: cleanCategoryRaw, // keep your stored category format
      tags: "default",
    })
      .sort({ priority: -1, createdAt: -1 })
      .lean();

    // If you store normalized category in DB, this helps too
    if (!doc) {
      doc = await ImageLibrary.findOne({
        category: cleanCategory,
        tags: "default",
      })
        .sort({ priority: -1, createdAt: -1 })
        .lean();
    }
  }

  // 2) global default
  if (!doc) {
    doc = await ImageLibrary.findOne({
      category: "global",
      tags: "default",
    })
      .sort({ priority: -1, createdAt: -1 })
      .lean();
  }

  // 3) any default
  if (!doc) {
    doc = await ImageLibrary.findOne({ tags: "default" })
      .sort({ priority: -1, createdAt: -1 })
      .lean();
  }

  if (!doc) return null;

  return {
    publicId: doc.publicId,
    url: doc.url,
    why: {
      mode: "db-default",
      reason: 'No match found, used ImageLibrary tag "default"',
      picked: {
        publicId: doc.publicId,
        url: doc.url,
        tags: Array.isArray(doc.tags) ? doc.tags : [],
        category: doc.category || "",
        priority: Number(doc.priority) || 0,
      },
    },
  };
}

// ------------------------------
// DB-FIRST PICKER (ImageLibrary)
// IMPORTANT: DO NOT "pick any" here.
// We must reserve default behavior for tag "default" only.
// Priority: tag match → category match → (return null)
// ------------------------------
async function pickFromImageLibrary({ tags = [], category = "" } = {}) {
  const cleanTags = Array.isArray(tags) ? tags.filter(Boolean) : [];
  const cleanCategoryRaw = String(category || "").trim();
  const cleanCategoryNorm = normalizeCategory(cleanCategoryRaw);

  // 1) TAG MATCH (best) — but require STRONG matches (non-generic)
  if (cleanTags.length) {
    const candidates = await ImageLibrary.find({
      tags: { $in: cleanTags },
    })
      .sort({ priority: -1, createdAt: -1 })
      .limit(IMAGE_LIBRARY_CANDIDATE_LIMIT)
      .lean();

    if (candidates.length) {
      let best = null;

      for (const img of candidates) {
        const imgTagsRaw = Array.isArray(img.tags) ? img.tags : [];
        const imgTagsNorm = imgTagsRaw.map(normStemTag).filter(Boolean);

        const matched = imgTagsNorm.filter((t) => cleanTags.includes(t));
        const strongMatches = matched.filter((t) => !isGenericTag(t));
        const genericMatches = matched.filter((t) => isGenericTag(t));

        const strongMatchCount = strongMatches.length;
        const genericMatchCount = genericMatches.length;

        const imgCatNorm = normalizeCategory(img.category || "");
        const sameCategory =
          !!cleanCategoryNorm &&
          !!imgCatNorm &&
          imgCatNorm === cleanCategoryNorm;

        // ✅ Proper scoring:
        // - strong matches dominate
        // - generic matches are tiny bonus (helps tie-break but not drive picks)
        // - category is small bonus
        // - priority is tie-breaker
        const score =
          strongMatchCount * 100 +
          genericMatchCount * 5 +
          (sameCategory ? 20 : 0) +
          (Number(img.priority) || 0);

        const row = {
          publicId: img.publicId,
          url: img.url,
          category: img.category || "",
          tags: imgTagsRaw,
          priority: Number(img.priority) || 0,
          strongMatchCount,
          genericMatchCount,
          strongMatches,
          genericMatches,
          sameCategory,
          score,
        };

        if (!best || row.score > best.score) best = row;
      }

      // ✅ HARD RULE: do not allow tag-pick unless strong match requirement is met
      if (
        best &&
        best.strongMatchCount >= IMAGE_LIBRARY_REQUIRED_STRONG_MATCHES
      ) {
        return {
          publicId: best.publicId,
          url: best.url,
          why: {
            mode: "db-tag-match",
            reason: "Matched ImageLibrary tags (strong matches required)",
            usedTags: cleanTags,
            picked: best.publicId,
            strongMatchCount: best.strongMatchCount,
            genericMatchCount: best.genericMatchCount,
            strongMatches: best.strongMatches,
            genericMatches: best.genericMatches,
            sameCategory: best.sameCategory,
            score: best.score,
          },
        };
      }
      // else: continue to category fallback
    }
  }

  // 2) CATEGORY FALLBACK (still only ImageLibrary)
  if (cleanCategoryRaw) {
    // try raw category first (your current DB seems to store raw strings)
    let cat = await ImageLibrary.findOne({ category: cleanCategoryRaw })
      .sort({ priority: -1, createdAt: -1 })
      .lean();

    // also try normalized category in case your DB stores slugs
    if (!cat && cleanCategoryNorm) {
      cat = await ImageLibrary.findOne({ category: cleanCategoryNorm })
        .sort({ priority: -1, createdAt: -1 })
        .lean();
    }

    // IMPORTANT: don't allow a category image that is actually the default card
    // (if you want category images, keep separate assets; default is only tag:"default")
    if (cat?.publicId && !isDefaultPlaceholder(cat.publicId, cat.url)) {
      return {
        publicId: cat.publicId,
        url: cat.url,
        why: {
          mode: "db-category-fallback",
          reason: "No strong tag match; fell back to category in ImageLibrary",
          category: cleanCategoryRaw,
          picked: cat.publicId,
        },
      };
    }
  }

  return null;
}

/**
 * Main orchestrator.
 * Mutates `article` in-place:
 *  - keep existing real imagePublicId / imageUrl
 *  - if default placeholder → treat as missing so picker can run
 *  - try ImageLibrary (tag match, then category)
 *  - if no match -> ImageLibrary "default" (tag: default)
 *  - if still nothing -> DEFAULT_PUBLIC_ID (env), used only if library empty
 */
async function decideAndAttach(article = {}, _opts = {}) {
  assert(article, "article is required");
  const meta = normalizeArticleInput(article);

  // ✅ If current image is just the default placeholder, clear it so picker is allowed
  if (isDefaultPlaceholder(article.imagePublicId, article.imageUrl)) {
    article.imagePublicId = null;
    article.imageUrl = null;
  }

  // 1) Respect an existing REAL Cloudinary public id (not default)
  if (article.imagePublicId && article.imagePublicId !== DEFAULT_PUBLIC_ID) {
    if (!article.autoImageDebug) {
      article.autoImageDebug = {
        mode: "kept-existing-public-id",
        picked: article.imagePublicId,
        reason: "Existing imagePublicId was already set",
      };
    }
    return "kept-existing-public-id";
  }

  // 2) Respect an existing REAL imageUrl (manual URL)
  if (article.imageUrl && !isPlaceholderUrl(article.imageUrl)) {
    if (!article.autoImageDebug) {
      article.autoImageDebug = {
        mode: "kept-existing-url",
        picked: article.imageUrl,
        reason: "Existing imageUrl was already set",
      };
    }
    return "kept-existing-url";
  }

  // 3) Try DB-first (ImageLibrary: tag -> category)
  let picked = null;

  try {
    picked = await pickFromImageLibrary({
      category: meta.category,
      tags: meta.tags,
    });
  } catch (err) {
    console.error("[imageStrategy] pickFromImageLibrary error:", err);
    picked = null;
  }

  if (picked?.publicId) {
    article.imagePublicId = picked.publicId;
    const safeUrl =
      typeof picked.url === "string" ? picked.url.replace(/\s+/g, "") : "";
    article.imageUrl =
      safeUrl || cloudinary.url(picked.publicId, { secure: true });

    article.autoImageDebug = picked.why || {
      mode: "db-first",
      picked: picked.publicId,
      reason: "Picked from ImageLibrary",
    };

    article.autoImagePicked = true;
    article.autoImagePickedAt = new Date();

    if (!article.imageAlt) {
      article.imageAlt = meta.imageAlt || meta.title || "News image";
    }

    return "attached-db-image";
  }

  // 4) No match -> ALWAYS use ImageLibrary tag:"default"
  let dbDefault = null;

  try {
    dbDefault = await pickDefaultFromImageLibrary({ category: meta.category });
  } catch (err) {
    console.error("[imageStrategy] pickDefaultFromImageLibrary error:", err);
    dbDefault = null;
  }

  if (dbDefault?.publicId) {
    article.imagePublicId = dbDefault.publicId;
    const safeUrl =
      typeof dbDefault.url === "string" ? dbDefault.url.replace(/\s+/g, "") : "";
    article.imageUrl =
      safeUrl || cloudinary.url(dbDefault.publicId, { secure: true });

    article.autoImageDebug = dbDefault.why || {
      mode: "db-default",
      picked: dbDefault.publicId,
      reason: 'No match found, used ImageLibrary tag "default"',
    };

    article.autoImagePicked = true;
    article.autoImagePickedAt = new Date();

    if (!article.imageAlt) {
      article.imageAlt = meta.imageAlt || meta.title || "News image";
    }

    return "attached-db-default-image";
  }

  // 5) Final hard fallback (only if ImageLibrary is empty or broken)
  if (!article.imagePublicId && DEFAULT_PUBLIC_ID) {
    article.imagePublicId = DEFAULT_PUBLIC_ID;
    article.imageUrl = cloudinary.url(DEFAULT_PUBLIC_ID, { secure: true });

    article.autoImageDebug = {
      mode: "fallback-default",
      picked: DEFAULT_PUBLIC_ID,
      reason: "ImageLibrary empty/unavailable; used hard default",
    };

    // note: hard fallback is not a real "pick"
    article.autoImagePicked = false;
    article.autoImagePickedAt = null;

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
