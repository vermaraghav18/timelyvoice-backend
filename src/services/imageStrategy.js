// backend/src/services/imageStrategy.js
// Image Strategy Orchestrator (IMAGE-LIBRARY ONLY)

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

const IMAGE_LIBRARY_REQUIRED_STRONG_MATCHES = Math.max(
  3,
  parseInt(process.env.IMAGE_LIBRARY_REQUIRED_STRONG_MATCHES || "3", 10) || 3
);

const IMAGE_LIBRARY_MIN_CONFIDENCE = parseInt(
  process.env.IMAGE_LIBRARY_MIN_CONFIDENCE || "110",
  10
);

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

function isDefaultPlaceholder(publicId, imageUrl) {
  return (
    (typeof publicId === "string" &&
      (publicId.includes("/defaults/") ||
        publicId.includes("news-images/default"))) ||
    (typeof imageUrl === "string" && imageUrl.includes("news-images/default"))
  );
}

function normalizeTag(raw = "") {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  const noHash = s.replace(/^#+/g, "");
  return noHash.replace(/[^a-z0-9_-]/g, "");
}

function normStemTag(raw = "") {
  return normalizeTag(raw);
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
  return normalizeTag(raw);
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

function inferCategoryBucket(meta) {
  const cat = normalizeCategory(meta.category);
  const text = `${meta.title || ""} ${meta.summary || ""}`.toLowerCase();

  if (cat.includes("politic")) return "politics";
  if (cat.includes("sport")) return "sports";
  if (cat.includes("finance") || cat.includes("business")) return "finance";
  if (cat.includes("entertain") || cat.includes("bollywood")) return "entertainment";
  if (cat.includes("health")) return "health";
  if (cat.includes("world")) return "world";
  if (cat === "india") return "india";

  for (const [bucket, words] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const w of words) {
      if (text.includes(w)) {
        if (bucket === "space") return "world";
        return bucket;
      }
    }
  }

  return "";
}

async function pickDefaultFromImageLibrary({ category = "" } = {}) {
  const cleanCategoryRaw = String(category || "").trim();
  const cleanCategoryNorm = normalizeCategory(cleanCategoryRaw);

  let doc = null;

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

  if (!doc) {
    doc = await ImageLibrary.findOne({
      category: "global",
      tags: "default",
    })
      .sort({ priority: -1, createdAt: -1 })
      .lean();
  }

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
    },
  };
}

function scoreCandidate({
  imgTagsNorm,
  imgCategoryNorm,
  imgPriority,
  cleanTags,
  keywordTags,
  articleCategoryNorm,
  bucket,
}) {
  const matchedTags = imgTagsNorm.filter((t) => cleanTags.includes(t));
  const strongTagMatches = matchedTags.filter((t) => !isGenericTag(t));
  const genericTagMatches = matchedTags.filter((t) => isGenericTag(t));

  const matchedKeywords = imgTagsNorm.filter((t) => keywordTags.includes(t));
  const strongKeywordMatches = matchedKeywords.filter((t) => !isGenericTag(t));
  const genericKeywordMatches = matchedKeywords.filter((t) => isGenericTag(t));

  const sameCategory =
    !!articleCategoryNorm && !!imgCategoryNorm && imgCategoryNorm === articleCategoryNorm;

  const negativeList = bucket ? NEGATIVE_TAGS_BY_CATEGORY[bucket] || [] : [];
  let penalty = 0;

  if (negativeList.length) {
    for (const bad of negativeList) {
      const badNorm = normalizeToken(bad);
      if (!badNorm) continue;
      if (imgTagsNorm.includes(badNorm)) penalty += 60;
    }
  }

  const score =
    strongTagMatches.length * 120 +
    strongKeywordMatches.length * 90 +
    genericTagMatches.length * 5 +
    genericKeywordMatches.length * 2 +
    (sameCategory ? 20 : 0) +
    (Number(imgPriority) || 0) -
    penalty;

  const strongMatchCount = new Set([...strongTagMatches, ...strongKeywordMatches]).size;

  return {
    score,
    strongMatchCount,
    sameCategory,
    penalty,
    strongTagMatches,
    genericTagMatches,
    matchedKeywords,
    strongKeywordMatches,
    genericKeywordMatches,
  };
}

/* ---------------------------------------------------------------- */
/* PICK BEST IMAGE (single) */
/* ---------------------------------------------------------------- */

async function pickFromImageLibrary({ meta } = {}) {
  const cleanTags = meta.tags || [];
  const categoryNorm = normalizeCategory(meta.category);

  const keywords = extractKeywords(meta.title || "", meta.summary || "", 40)
    .map(normStemTag)
    .filter(Boolean);

  const discoverTokens = dedupe([...cleanTags, ...keywords]);
  const bucket = inferCategoryBucket(meta);

  if (!discoverTokens.length) return null;

  const candidates = await ImageLibrary.find({
    tags: { $in: discoverTokens },
  })
    .sort({ priority: -1, createdAt: -1 })
    .limit(IMAGE_LIBRARY_CANDIDATE_LIMIT)
    .lean();

  if (!candidates.length) return null;

  const scored = candidates.map((img) => {
    const imgTagsNorm = (img.tags || []).map(normStemTag).filter(Boolean);
    const imgCatNorm = normalizeCategory(img.category || "");

    const s = scoreCandidate({
      imgTagsNorm,
      imgCategoryNorm: imgCatNorm,
      imgPriority: img.priority,
      cleanTags,
      keywordTags: keywords,
      articleCategoryNorm: categoryNorm,
      bucket,
    });

    return {
      publicId: img.publicId,
      url: img.url,
      createdAt: img.createdAt,
      priority: img.priority,
      ...s,
    };
  });

  const eligible = scored
    .filter((r) => r.strongMatchCount >= IMAGE_LIBRARY_REQUIRED_STRONG_MATCHES)
    .filter((r) => r.score >= IMAGE_LIBRARY_MIN_CONFIDENCE)
    .sort((a, b) => b.score - a.score);

  if (!eligible.length) return null;

  const best = eligible[0];

  return {
    publicId: best.publicId,
    url: best.url,
    why: {
      mode: "db-advanced-match",
      picked: best.publicId,
      score: best.score,
      strongMatchCount: best.strongMatchCount,
    },
  };
}

/* ---------------------------------------------------------------- */
/* NEW: MULTI-CANDIDATE (FOR ARROWS) */
/* ---------------------------------------------------------------- */

async function getImageCandidatesForArticle(meta = {}, { limit = 24 } = {}) {
  const clean = normalizeArticleInput(meta);
  const cleanTags = clean.tags || [];
  const categoryNorm = normalizeCategory(clean.category);

  const keywords = extractKeywords(clean.title || "", clean.summary || "", 40)
    .map(normStemTag)
    .filter(Boolean);

  const discoverTokens = dedupe([...cleanTags, ...keywords]);
  const bucket = inferCategoryBucket(clean);

  if (!discoverTokens.length) return { candidates: [], why: { mode: "no-tokens" } };

  const docs = await ImageLibrary.find({
    tags: { $in: discoverTokens },
  })
    .sort({ priority: -1, createdAt: -1 })
    .limit(IMAGE_LIBRARY_CANDIDATE_LIMIT)
    .lean();

  if (!docs.length) return { candidates: [], why: { mode: "no-db-candidates" } };

  const scored = docs.map((img) => {
    const imgTagsNorm = (img.tags || []).map(normStemTag).filter(Boolean);
    const imgCatNorm = normalizeCategory(img.category || "");

    const s = scoreCandidate({
      imgTagsNorm,
      imgCategoryNorm: imgCatNorm,
      imgPriority: img.priority,
      cleanTags,
      keywordTags: keywords,
      articleCategoryNorm: categoryNorm,
      bucket,
    });

    return {
      publicId: img.publicId,
      url: img.url,
      createdAt: img.createdAt,
      priority: img.priority,
      ...s,
    };
  });

  const eligible = scored
    .filter((r) => r.strongMatchCount >= IMAGE_LIBRARY_REQUIRED_STRONG_MATCHES)
    .filter((r) => r.score >= IMAGE_LIBRARY_MIN_CONFIDENCE)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.createdAt) - new Date(a.createdAt);
    })
    .slice(0, limit);

  return {
    candidates: eligible,
    why: {
      mode: "db-candidates",
      eligibleCount: eligible.length,
    },
  };
}

/* ---------------------------------------------------------------- */
/* MAIN ORCHESTRATOR */
/* ---------------------------------------------------------------- */

async function decideAndAttach(article = {}) {
  assert(article, "article is required");
  const meta = normalizeArticleInput(article);

  if (isDefaultPlaceholder(article.imagePublicId, article.imageUrl)) {
    article.imagePublicId = null;
    article.imageUrl = null;
  }

  if (article.imagePublicId && article.imagePublicId !== DEFAULT_PUBLIC_ID) {
    return "kept-existing-public-id";
  }

  if (article.imageUrl && !isPlaceholderUrl(article.imageUrl)) {
    return "kept-existing-url";
  }

  const picked = await pickFromImageLibrary({ meta });

  if (picked?.publicId) {
    article.imagePublicId = picked.publicId;
    article.imageUrl = picked.url || cloudinary.url(picked.publicId, { secure: true });
    article.autoImagePicked = true;
    article.autoImagePickedAt = new Date();
    return "attached-db-image";
  }

  const dbDefault = await pickDefaultFromImageLibrary({ category: meta.category });

  if (dbDefault?.publicId) {
    article.imagePublicId = dbDefault.publicId;
    article.imageUrl =
      dbDefault.url || cloudinary.url(dbDefault.publicId, { secure: true });
    return "attached-db-default-image";
  }

  article.imagePublicId = DEFAULT_PUBLIC_ID;
  article.imageUrl = cloudinary.url(DEFAULT_PUBLIC_ID, { secure: true });
  return "attached-default-image";
}

module.exports = {
  decideAndAttach,
  getImageCandidatesForArticle,
};
