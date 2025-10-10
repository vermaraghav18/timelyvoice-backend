// controllers/article.controller.js
const Article = require('../models/Article');
const Category = require('../models/Category');
const slugify = require('slugify');

function escRegex(str = '') {
  // escape regex metacharacters to avoid invalid patterns
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

exports.list = async (req, res) => {
  try {
    let { q = '', status, category, tag, page = 1, limit = 20 } = req.query;

    // normalise numbers
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

    const filter = {};

    // default to published if not specified (adjust if you want drafts)
    filter.status = status || 'published';

    // category: allow slug or name; your Article stores category NAME
    if (category) {
      const catDoc = await Category.findOne({
        $or: [
          { slug: category },
          { slug: slugify(category) },
          { name: category },
        ],
      })
        .select('name')
        .lean();

      // fallback to provided value so old data still works
      filter.category = catDoc ? catDoc.name : category;
    }

    // tag: simple contains (supports array of strings)
    if (tag) {
      filter.tags = tag;
    }

    // q: safe regex over title + summary (excerpt can be summary in your schema)
    if (q && String(q).trim()) {
      const rx = new RegExp(escRegex(String(q).trim()), 'i');
      filter.$or = [{ title: rx }, { summary: rx }, { slug: rx }];
    }

    const cursor = Article.find(filter)
      .select('title slug publishedAt') // light response
      .sort({ publishedAt: -1, updatedAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    const [itemsRaw, total] = await Promise.all([
      cursor,
      Article.countDocuments(filter),
    ]);

    const items = itemsRaw.map((a) => ({
      id: String(a._id),
      title: a.title,
      slug: a.slug,
      publishedAt: a.publishedAt,
    }));

    res.json({
      items,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
      limit: limitNum,
    });
  } catch (err) {
    console.error('GET /api/articles list error:', err);
    res.status(500).json({ error: 'Failed to list/search articles' });
  }
};
