// backend/src/routes/topnews.js
const router = require("express").Router();
const Article = require("../models/Article");

// Category model (exists in this project)
let Category;
try {
  Category = require("../models/Category");
} catch (e) {
  // If model path differs, adjust require accordingly.
  Category = null;
}

/** ------- helpers ------- */
function normalizeMedia(a) {
  const cover = a.cover;
  const imageUrl =
    a.imageUrl ||
    (typeof cover === "string" ? cover : null) ||
    (cover && typeof cover === "object" ? cover.url : null) ||
    null;

  const imageAlt =
    a.imageAlt ||
    (cover && typeof cover === "object" ? cover.alt : null) ||
    a.title ||
    "";

  return { imageUrl, imageAlt };
}

const HEX24 = /^[a-f0-9]{24}$/i;

// category map cache (refresh every 60s)
const catCache = {
  ts: 0,
  map: new Map(), // idStr -> { name, slug }
};
async function getCategoryMap() {
  // If no Category model, just return existing (may be empty)
  if (!Category) return catCache.map;

  const now = Date.now();
  if (now - catCache.ts > 60 * 1000 || catCache.map.size === 0) {
    const rows = await Category.find({})
      .select("_id name slug")
      .lean();

    const m = new Map();
    for (const c of rows) {
      const id = (c._id && c._id.toString()) || "";
      m.set(id, { name: c.name || c.slug || "General", slug: c.slug || c.name || "general" });
    }
    catCache.map = m;
    catCache.ts = now;
  }
  return catCache.map;
}

function resolveCategoryLabel(cat, catMap) {
  // string name
  if (typeof cat === "string") {
    // If it's an ObjectId-looking string, try to resolve
    if (HEX24.test(cat)) {
      const hit = catMap.get(cat);
      if (hit) return hit.name;
      return "General";
    }
    // otherwise it is already a human label
    return cat;
  }

  // object with name/slug
  if (cat && typeof cat === "object") {
    // mongoose ObjectId instance
    if (cat._bsontype === "ObjectId" || typeof cat.toString === "function") {
      const id = cat.toString();
      if (HEX24.test(id)) {
        const hit = catMap.get(id);
        if (hit) return hit.name;
        return "General";
      }
    }
    // embedded doc { id|_id, name, slug }
    const name = cat.name || cat.slug;
    if (name) return name;
    const id = cat.id || cat._id;
    if (id) {
      const idStr = id.toString();
      const hit = catMap.get(idStr);
      if (hit) return hit.name;
    }
  }

  return "General";
}

function stripArticleFields(a, catMap) {
  const { imageUrl, imageAlt } = normalizeMedia(a);
  return {
    id: a._id,
    title: a.title,
    slug: a.slug,
    summary: a.summary || "",
    imageUrl,
    imageAlt,
    publishedAt: a.publishedAt,
    author: a.author,
    category: resolveCategoryLabel(a.category, catMap), // <-- always a clean string
  };
}

/**
 * GET /api/top-news
 * query: ?limit=50&page=1
 * Newest first by publishedAt (with fallbacks).
 */
router.get("/", async (req, res, next) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 50)));
    const page = Math.max(1, Number(req.query.page ?? 1));
    const skip = (page - 1) * limit;

   const now = new Date();
    const q = {
      status: "published",
      publishedAt: { $lte: now },
    };


    const [catMap, rows] = await Promise.all([
      getCategoryMap(),
      Article.find(q)
        .select(
          "title slug summary imageUrl imageAlt cover publishedAt updatedAt author category"
        )
        .sort({ publishedAt: -1, updatedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    // avoid stale for breaking news page
    res.set("Cache-Control", "no-store");

    res.json({
      items: rows.map((a) => stripArticleFields(a, catMap)),
      page,
      limit,
      total: rows.length,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
