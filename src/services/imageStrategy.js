// backend/src/services/imageStrategy.js
// Cloudinary-only Image Strategy Orchestrator
//
// Purpose:
// - If article has a real image (manual or real Cloudinary), keep it
// - If article has only default placeholder, treat as "no image" so picker can run
// - If no real image, try DB-first ImageLibrary picker
// - If still nothing, try strict tag-first Cloudinary picker (chooseHeroImage)
// - If still nothing, fall back to ImageLibrary "default" image
// - If still nothing, fall back to DEFAULT_PUBLIC_ID

const cloudinary = require("cloudinary").v2;
const assert = require("assert");
const { chooseHeroImage } = require("./imagePicker");
const ImageLibrary = require("../models/ImageLibrary");

const DEFAULT_PUBLIC_ID =
  process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID ||
  "news-images/defaults/fallback-hero";

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
    // If it isn't a valid URL, don't treat it as placeholder automatically
    // (manual relative URLs etc. should not get nuked here)
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
// Tag normalization (must match picker + AI uploader)
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

function normalizeArticleInput(a = {}) {
  return {
    title: a.title || "",
    summary: a.summary || "",
    slug: a.slug || "",
    category: a.category || "",
    tags: dedupe(normalizeTagsInput(a.tags)),
    imageAlt: a.imageAlt || "",
  };
}

// ------------------------------
// DEFAULT PICKER (ImageLibrary)
// Used ONLY when no match exists.
// Rule: Image must have tag "default"
// Preference order:
// 1) category-specific default (category = article category)
// 2) global default (category = "global")
// 3) any default (tag-only)
// ------------------------------
async function pickDefaultFromImageLibrary({ category = "" } = {}) {
  const cleanCategory = String(category || "").trim();

  // 1) category-specific default
  let doc = null;
  if (cleanCategory) {
    doc = await ImageLibrary.findOne({
      category: cleanCategory,
      tags: "default",
    })
      .sort({ priority: -1, createdAt: -1 })
      .lean();
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
    doc = await ImageLibrary.findOne({
      tags: "default",
    })
      .sort({ priority: -1, createdAt: -1 })
      .lean();
  }

  if (!doc) return null;

  return {
    publicId: doc.publicId,
    url: doc.url,
    why: {
      mode: "db-default",
      reason: "No tag match found, used ImageLibrary default",
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
// ------------------------------
async function pickFromImageLibrary({ tags = [], category = "" } = {}) {
  const cleanTags = Array.isArray(tags) ? tags.filter(Boolean) : [];
  const cleanCategory = String(category || "").trim();

  if (!cleanTags.length) return null;

  // Find images that match ANY of the tags (we will score in JS)
  const candidates = await ImageLibrary.find({
    tags: { $in: cleanTags },
  })
    .sort({ priority: -1, createdAt: -1 })
    .limit(50)
    .lean();

  if (!candidates.length) return null;

  // score by matchCount + category boost + priority
  let best = null;

  for (const img of candidates) {
    const imgTags = Array.isArray(img.tags) ? img.tags : [];
    const matchCount = imgTags.filter((t) => cleanTags.includes(t)).length;
    const sameCategory =
      cleanCategory && img.category && img.category === cleanCategory;

    const score =
      matchCount * 10 + (sameCategory ? 5 : 0) + (Number(img.priority) || 0);

    const row = {
      publicId: img.publicId,
      url: img.url,
      category: img.category || "",
      tags: imgTags,
      priority: Number(img.priority) || 0,
      matchCount,
      sameCategory,
      score,
    };

    if (!best || row.score > best.score) best = row;
  }

  if (!best) return null;

  return {
    publicId: best.publicId,
    url: best.url,
    why: {
      mode: "db-first",
      requiredMatches: Number(process.env.CLOUDINARY_AUTOPICK_MIN_TAG_MATCHES || 2),
      bestMatchCount: best.matchCount,
      bestCategoryMatch: best.sameCategory,
      usedTags: cleanTags,
      picked: {
        publicId: best.publicId,
        url: best.url,
        tags: best.tags,
        category: best.category,
        priority: best.priority,
      },
      top3: candidates
        .map((img) => {
          const imgTags = Array.isArray(img.tags) ? img.tags : [];
          const matchCount = imgTags.filter((t) => cleanTags.includes(t)).length;
          const sameCategory =
            cleanCategory && img.category && img.category === cleanCategory;

          return {
            publicId: img.publicId,
            matchCount,
            sameCategory,
            priority: Number(img.priority) || 0,
            category: img.category || "",
          };
        })
        .sort((a, b) => (b.matchCount - a.matchCount) || (b.priority - a.priority))
        .slice(0, 3),
    },
  };
}

/**
 * Main orchestrator.
 * Mutates `article` in-place:
 *  - keep existing real imagePublicId / imageUrl
 *  - if default placeholder → treat as missing so picker can run
 *  - try ImageLibrary (db-first)
 *  - try chooseHeroImage (strict tag-first)
 *  - fallback to ImageLibrary "default" only if nothing picked
 *  - fallback to DEFAULT_PUBLIC_ID only if nothing picked
 */
async function decideAndAttach(article = {}, opts = {}) {
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

  // 3) Try DB-first (ImageLibrary)
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

  if (picked && picked.publicId) {
    article.imagePublicId = picked.publicId;

    const safeUrl = typeof picked.url === "string" ? picked.url.replace(/\s+/g, "") : "";
    article.imageUrl = safeUrl || cloudinary.url(picked.publicId, { secure: true });

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

  // 4) Try Cloudinary picker (STRICT TAG-FIRST)
  try {
    picked = await chooseHeroImage({
      title: meta.title,
      summary: meta.summary,
      slug: meta.slug,
      category: meta.category,
      tags: meta.tags,
    });
  } catch (err) {
    console.error("[imageStrategy] chooseHeroImage error:", err);
    picked = null;
  }

  if (picked && picked.publicId) {
    article.imagePublicId = picked.publicId;
    article.imageUrl =
      picked.url || cloudinary.url(picked.publicId, { secure: true });

    // ✅ store why (same debug object used everywhere)
    article.autoImageDebug = picked.why || {
      mode: "cloudinary-tag-first",
      picked: picked.publicId,
      reason: "Auto-picked from Cloudinary",
    };

    // ✅ flags (ONLY when actually picked)
    article.autoImagePicked = true;
    article.autoImagePickedAt = new Date();

    if (!article.imageAlt) {
      article.imageAlt = meta.imageAlt || meta.title || "News image";
    }
    return "attached-cloudinary-image";
  }

  // 5) Fallback to ImageLibrary DEFAULT (ONLY if nothing else exists)
  // To use:
  // - Upload ONE ImageLibrary image with tag "default"
  // - Recommended global default: category="global", tags=["default"], priority=0
  // - Optional category default: category="world", tags=["default"]
  let dbDefault = null;

  try {
    dbDefault = await pickDefaultFromImageLibrary({ category: meta.category });
  } catch (err) {
    console.error("[imageStrategy] pickDefaultFromImageLibrary error:", err);
    dbDefault = null;
  }

  if (dbDefault && dbDefault.publicId) {
    article.imagePublicId = dbDefault.publicId;

    const safeUrl =
      typeof dbDefault.url === "string" ? dbDefault.url.replace(/\s+/g, "") : "";
    article.imageUrl =
      safeUrl || cloudinary.url(dbDefault.publicId, { secure: true });

    article.autoImageDebug = dbDefault.why || {
      mode: "db-default",
      picked: dbDefault.publicId,
      reason: "No match found, used ImageLibrary default",
    };

    // ✅ It's still a system pick (eligible for repick if cleared later)
    article.autoImagePicked = true;
    article.autoImagePickedAt = new Date();

    if (!article.imageAlt) {
      article.imageAlt = meta.imageAlt || meta.title || "News image";
    }
    return "attached-db-default-image";
  }

  // 6) Final fallback default image (ONLY if DB default not present)
  if (!article.imagePublicId && DEFAULT_PUBLIC_ID) {
    article.imagePublicId = DEFAULT_PUBLIC_ID;
    article.imageUrl = cloudinary.url(DEFAULT_PUBLIC_ID, { secure: true });

    article.autoImageDebug = {
      mode: "fallback-default",
      picked: DEFAULT_PUBLIC_ID,
      reason: "No suitable Cloudinary/DB image found, used hard default",
    };

    // ✅ IMPORTANT: hard default fallback is NOT a "picked" image
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
