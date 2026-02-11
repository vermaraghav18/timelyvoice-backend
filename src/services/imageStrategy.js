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

const {
  isGenericTag,
  NEGATIVE_TAGS_BY_CATEGORY,
  CATEGORY_KEYWORDS,
} = require("./imagePickerRules");

const { extractKeywords, normalizeToken } = require("./textKeywords");

const DEFAULT_PUBLIC_ID =
  process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID ||
  "news-images/defaults/fallback-hero";

const IMAGE_LIBRARY_CANDIDATE_LIMIT = parseInt(
  process.env.IMAGE_LIBRARY_CANDIDATE_LIMIT || "300",
  10
);

// ✅ Require at least N “strong” (non-generic) matches for tag-pick
const IMAGE_LIBRARY_REQUIRED_STRONG_MATCHES = parseInt(
  process.env.IMAGE_LIBRARY_REQUIRED_STRONG_MATCHES || "1",
  10
);

// ✅ Confidence threshold: below this, do NOT pick by tags/keywords; go category/default.
// Tune if needed.
const IMAGE_LIBRARY_MIN_CONFIDENCE = parseInt(
  process.env.IMAGE_LIBRARY_MIN_CONFIDENCE || "110",
  10
);

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
        if (x && typeof x === "object") return x.value || x.label || x.name || "";
        return "";
      })
      .map(normStemTag)
      .filter(Boolean);
  }
  return [];
}

function normalizeCategory(raw = "") {
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
// Infer category bucket (for negative penalties) if category is messy.
// Uses article.category + keywords in title/summary
// ------------------------------
function inferCategoryBucket(meta) {
  const cat = normalizeCategory(meta.category);
  const text = `${meta.title || ""} ${meta.summary || ""}`.toLowerCase();

  // direct mapping by existing category string (best effort)
  if (cat.includes("politic")) return "politics";
  if (cat.includes("sport")) return "sports";
  if (cat.includes("finance") || cat.includes("business")) return "finance";
  if (cat.includes("entertain") || cat.includes("bollywood")) return "entertainment";
  if (cat.includes("health")) return "health";
  if (cat.includes("world")) return "world";
  if (cat === "india") return "india";

  // keyword-based
  for (const [bucket, words] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const w of words) {
      if (text.includes(w)) {
        // treat space as its own bucket only for penalties, otherwise it’s fine
        if (bucket === "space") return "world"; // don’t force category; only used for penalties
        return bucket;
      }
    }
  }

  return ""; // unknown
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
  const cleanCategoryNorm = normalizeCategory(cleanCategoryRaw);

  let doc = null;

  // 1) category-specific default
  if (cleanCategoryRaw) {
    doc = await ImageLibrary.findOne({
      category: cleanCategoryRaw,
      tags: "default",
    })
      .sort({ priority: -1, createdAt: -1 })
      .lean();

    if (!doc && cleanCategoryNorm) {
      doc = await ImageLibrary.findOne({
        category: cleanCategoryNorm,
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
// Advanced scoring for candidates
// ------------------------------
function scoreCandidate({
  imgTagsNorm,
  imgCategoryNorm,
  imgPriority,
  cleanTags,
  keywordTags,
  articleCategoryNorm,
  bucket,
}) {
  // matches from article tags
  const matchedTags = imgTagsNorm.filter((t) => cleanTags.includes(t));
  const strongTagMatches = matchedTags.filter((t) => !isGenericTag(t));
  const genericTagMatches = matchedTags.filter((t) => isGenericTag(t));

  // matches from title/summary keywords (only strong, by definition)
  const matchedKeywords = imgTagsNorm.filter((t) => keywordTags.includes(t));

  // same category?
  const sameCategory =
    !!articleCategoryNorm && !!imgCategoryNorm && imgCategoryNorm === articleCategoryNorm;

  // negative penalties based on inferred bucket
  const negativeList = bucket ? NEGATIVE_TAGS_BY_CATEGORY[bucket] || [] : [];
  let penalty = 0;
  let penaltyHits = [];

  if (negativeList.length) {
    for (const bad of negativeList) {
      const badNorm = normalizeToken(bad);
      if (!badNorm) continue;
      if (imgTagsNorm.includes(badNorm)) {
        penalty += 60; // strong penalty
        penaltyHits.push(badNorm);
      }
    }
  }

  // Score weights:
  // - strong tag matches are king
  // - keyword matches from title are also strong
  // - generic tags are tiny (never drive a pick)
  // - category small bonus
  // - priority tie-break
  const score =
    strongTagMatches.length * 120 +
    matchedKeywords.length * 90 +
    genericTagMatches.length * 5 +
    (sameCategory ? 20 : 0) +
    (Number(imgPriority) || 0) -
    penalty;

  const strongMatchCount = strongTagMatches.length + matchedKeywords.length; // count both as strong

  return {
    score,
    sameCategory,
    penalty,
    penaltyHits,
    matchedTags,
    strongTagMatches,
    genericTagMatches,
    matchedKeywords,
    strongMatchCount,
  };
}

// ------------------------------
// DB-FIRST PICKER (ImageLibrary)
// Priority: strong tags/keywords → category → null
// ------------------------------
async function pickFromImageLibrary({ meta } = {}) {
  const cleanTags = Array.isArray(meta?.tags) ? meta.tags.filter(Boolean) : [];
  const categoryRaw = String(meta?.category || "").trim();
  const categoryNorm = normalizeCategory(categoryRaw);

  // Keywords from title/summary (normalize like tags so we can compare)
  const keywords = extractKeywords(meta?.title || "", meta?.summary || "", 40)
    .map(normStemTag)
    .filter(Boolean);

  // Use both tags and keywords to widen candidate discovery,
  // but scoring is what decides.
  const discoverTokens = dedupe([...cleanTags, ...keywords]);

  const bucket = inferCategoryBucket(meta);

  // 1) TAG/KEYWORD MATCH (best)
  if (discoverTokens.length) {
    const candidates = await ImageLibrary.find({
      tags: { $in: discoverTokens },
    })
      .sort({ priority: -1, createdAt: -1 })
      .limit(IMAGE_LIBRARY_CANDIDATE_LIMIT)
      .lean();

    if (candidates.length) {
      let best = null;

      for (const img of candidates) {
        const imgTagsRaw = Array.isArray(img.tags) ? img.tags : [];
        const imgTagsNorm = imgTagsRaw.map(normStemTag).filter(Boolean);

        const imgCatNorm = normalizeCategory(img.category || "");
        const s = scoreCandidate({
          imgTagsNorm,
          imgCategoryNorm: imgCatNorm,
          imgPriority: Number(img.priority) || 0,
          cleanTags,
          keywordTags: keywords,
          articleCategoryNorm: categoryNorm,
          bucket,
        });

        const row = {
          publicId: img.publicId,
          url: img.url,
          category: img.category || "",
          tags: imgTagsRaw,
          priority: Number(img.priority) || 0,
          ...s,
        };

        if (!best || row.score > best.score) best = row;
      }

      // ✅ HARD RULE 1: Require minimum strong matches (non-generic tags + title keywords)
      if (best && best.strongMatchCount >= IMAGE_LIBRARY_REQUIRED_STRONG_MATCHES) {
        // ✅ HARD RULE 2: Confidence threshold
        if (best.score >= IMAGE_LIBRARY_MIN_CONFIDENCE) {
          return {
            publicId: best.publicId,
            url: best.url,
            why: {
              mode: "db-advanced-match",
              reason: "Picked by strong tags + title keywords + negative penalties",
              usedTags: cleanTags,
              usedKeywords: keywords,
              inferredBucket: bucket || "",
              picked: best.publicId,
              score: best.score,
              strongMatchCount: best.strongMatchCount,
              sameCategory: best.sameCategory,
              penalty: best.penalty,
              penaltyHits: best.penaltyHits,
              strongTagMatches: best.strongTagMatches,
              genericTagMatches: best.genericTagMatches,
              keywordMatches: best.matchedKeywords,
            },
          };
        }

        // Not confident -> fall back to category/default
        return {
          publicId: null,
          why: {
            mode: "db-advanced-low-confidence",
            reason: "Had some matches but confidence too low; using category/default",
            bestCandidate: {
              publicId: best.publicId,
              score: best.score,
              strongMatchCount: best.strongMatchCount,
              penalty: best.penalty,
              penaltyHits: best.penaltyHits,
              strongTagMatches: best.strongTagMatches,
              keywordMatches: best.matchedKeywords,
              genericTagMatches: best.genericTagMatches,
            },
            minConfidence: IMAGE_LIBRARY_MIN_CONFIDENCE,
          },
        };
      }

      // Not enough strong matches -> fall back to category/default
      return {
        publicId: null,
        why: {
          mode: "db-advanced-insufficient-strong",
          reason:
            "Only generic/no strong matches (e.g., india/world). Using category/default.",
          requiredStrong: IMAGE_LIBRARY_REQUIRED_STRONG_MATCHES,
          usedTags: cleanTags,
          usedKeywords: keywords,
          inferredBucket: bucket || "",
        },
      };
    }
  }

  // 2) CATEGORY FALLBACK
  if (categoryRaw) {
    let cat = await ImageLibrary.findOne({ category: categoryRaw })
      .sort({ priority: -1, createdAt: -1 })
      .lean();

    if (!cat && categoryNorm) {
      cat = await ImageLibrary.findOne({ category: categoryNorm })
        .sort({ priority: -1, createdAt: -1 })
        .lean();
    }

    if (cat?.publicId && !isDefaultPlaceholder(cat.publicId, cat.url)) {
      return {
        publicId: cat.publicId,
        url: cat.url,
        why: {
          mode: "db-category-fallback",
          reason: "No confident strong match; fell back to category in ImageLibrary",
          category: categoryRaw,
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
 *  - try ImageLibrary (advanced match, then category)
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

  // 1) Respect existing REAL Cloudinary public id (not default)
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

  // 2) Respect existing REAL imageUrl (manual URL)
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

  // 3) Try ImageLibrary advanced match (tags+keywords+penalty), then category fallback
  let picked = null;

  try {
    picked = await pickFromImageLibrary({ meta });
  } catch (err) {
    console.error("[imageStrategy] pickFromImageLibrary error:", err);
    picked = null;
  }

  // If pickFromImageLibrary returned debug-only (no publicId), preserve debug
  if (picked && !picked.publicId && picked.why) {
    article.autoImageDebug = picked.why;
  }

  if (picked?.publicId) {
    article.imagePublicId = picked.publicId;
    const safeUrl =
      typeof picked.url === "string" ? picked.url.replace(/\s+/g, "") : "";
    article.imageUrl =
      safeUrl || cloudinary.url(picked.publicId, { secure: true });

    article.autoImageDebug = picked.why || {
      mode: "db-advanced-match",
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

  // 4) No confident match -> ALWAYS use ImageLibrary tag:"default"
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

    // Keep earlier debug (low-confidence) if present, but attach default info too
    const prev = article.autoImageDebug;
    article.autoImageDebug = {
      ...(prev ? { prev } : {}),
      ...(dbDefault.why || {}),
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
