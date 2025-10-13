// controllers/article.controller.js
const Article = require('../models/Article');
const Category = require('../models/Category');
const slugify = require('slugify');

function escRegex(str = '') {
  // escape regex metacharacters to avoid invalid patterns
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * GET /api/articles
 * Query params:
 *   q        - search text (safe regex on title/summary/slug)
 *   status   - defaults to 'published'
 *   category - slug or name; stored as Category.name in Article
 *   tag      - exact tag match
 *   page     - 1-based page number
 *   limit    - requested page size (hard-capped below)
 *
 * Returns a slim, fast list (excludes heavy fields) with stable newest-first sort.
 */
exports.list = async (req, res) => {
  try {
    // --- BEGIN optimized listing block ---
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitReq = Math.max(parseInt(req.query.limit || '0', 10), 0);
    // Hard cap to keep payloads small (adjust if needed)
    const limit = Math.min(limitReq || 12, 24);

    const q = {};

    // status: default to 'published' (keeps behavior consistent with your previous code)
    q.status = req.query.status || 'published';

    // category: allow slug or name; Article stores category NAME
    if (req.query.category) {
      const raw = String(req.query.category);
      const catDoc = await Category
        .findOne({ $or: [{ slug: raw }, { slug: slugify(raw) }, { name: raw }] })
        .select('name')
        .lean();
      q.category = catDoc ? catDoc.name : raw; // fallback so old data still works
    }

    // tag: exact match (your Article schema stores an array of strings)
    if (req.query.tag) q.tags = req.query.tag;

    // q: safe regex over title + summary + slug (keeps compatibility even without a $text index)
    if (req.query.q && String(req.query.q).trim()) {
      const rx = new RegExp(escRegex(String(req.query.q).trim()), 'i');
      q.$or = [{ title: rx }, { summary: rx }, { slug: rx }];
    }

    // Projection: exclude heavy fields from lists
    const PROJECTION = {
      body: 0,
      bodyHtml: 0,
      // add any other large fields to exclude if needed
    };

    // Sort newest first (stable by _id as tiebreaker)
    const SORT = { publishedAt: -1, _id: -1 };

    const cursor = Article
      .find(q, PROJECTION)
      .sort(SORT)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean({ getters: true })   // lean for speed
      .maxTimeMS(5000);          // avoid long tail

    const [items, total] = await Promise.all([
      cursor.exec(),
      Article.countDocuments(q),
    ]);

    res.json({
      page,
      pageSize: items.length,
      total,
      items,
    });
    // --- END optimized listing block ---
  } catch (err) {
    console.error('GET /api/articles list error:', err);
    res.status(500).json({ error: 'Failed to list/search articles' });
  }
};
