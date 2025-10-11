// backend/src/routes/topnews.js
const router = require("express").Router();
const Article = require("../models/Article");

/** small helpers copied from sectionsPlan.service.js */
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
function stripArticleFields(a) {
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
    category: a.category,
  };
}

// Only main heads (exclude cities/states)
const MAIN_CATEGORIES = [
  "World",
  "Politics",
  "Business",
  "Entertainment",
  "General",
  "Health",
  "Science",
  "Sports",
  "Tech",
];

/**
 * GET /api/top-news
 * query: ?limit=50&page=1
 * Returns newest-first across MAIN_CATEGORIES.
 */
router.get("/", async (req, res, next) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 50)));
    const page = Math.max(1, Number(req.query.page ?? 1));
    const skip = (page - 1) * limit;

    const q = {
      status: "published",
      publishedAt: { $ne: null },
      category: { $in: MAIN_CATEGORIES },
    };

    const rows = await Article.find(q)
      .select("title slug summary imageUrl imageAlt cover publishedAt author category")
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json({
      items: rows.map(stripArticleFields),
      page,
      limit,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
