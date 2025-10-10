const express = require("express");
const router = express.Router();

const PageSectionV2 = require("../models/PageSectionV2");
// ⬇️ Adjust this path/name if your Article model is elsewhere
const Article = require("../models/Article");

/* ---------------------------
   Helpers
----------------------------*/

// Build a Mongo filter from the section.query JSON
function buildArticleQuery(q = {}) {
  const mongo = {};

  // category: support string or nested name
  if (q.category) {
    const cat = String(q.category);
    mongo.$or = [{ category: cat }, { "category.name": cat }];
  }

  // tags: allow tag / tags (string or array), match array of strings or array of {name}
  const t = q.tags ?? q.tag;
  if (t) {
    const tags = Array.isArray(t) ? t : [t];
    mongo.$or = (mongo.$or || []).concat([
      { tags: { $in: tags } },
      { "tags.name": { $in: tags } },
    ]);
  }

  // author
  if (q.author) {
    mongo.author = q.author;
  }

  // last N days
  if (q.days && Number(q.days) > 0) {
    const d = new Date();
    d.setDate(d.getDate() - Number(q.days));
    mongo.publishedAt = { $gte: d };
  }

  // free text
  if (q.q) {
    const re = new RegExp(String(q.q).trim(), "i");
    mongo.$or = (mongo.$or || []).concat([
      { title: re },
      { summary: re },
      { category: re },
      { "category.name": re },
    ]);
  }

  return mongo;
}

// Query Article collection for a section
async function fetchArticlesForSection(section) {
  const q = section.query || {};
  const where = buildArticleQuery(q);
  const limit = Math.min(Math.max(Number(q.limit) || 5, 1), 50);
  const sortField = q.sortBy || "publishedAt";
  const sort = { [sortField]: -1 };

  // return only fields the frontend needs
  const projection = {
    slug: 1,
    title: 1,
    author: 1,
    category: 1,
    summary: 1,
    imageUrl: 1,
    imageAlt: 1,
    thumbnailUrl: 1,
    cover: 1,
    publishedAt: 1,
  };

  const items = await Article.find(where)
    .sort(sort)
    .limit(limit)
    .select(projection)
    .lean();

  return items;
}

// Normalize request body for admin endpoints
function normalizeBody(b = {}) {
  const out = {
    key: String(b.key || "").trim(),
    title: b.title || "",
    type: b.type || b.template || "list_v1",
    side: b.side === "left" ? "left" : "right",
    order: Number(b.order) || 0,
    enabled: !!b.enabled,
    source: b.source && typeof b.source === "object" ? b.source : null,
    query: b.query && typeof b.query === "object" ? b.query : {},
    config: b.config && typeof b.config === "object" ? b.config : {},
    ui: b.ui && typeof b.ui === "object" ? b.ui : {},
    items: Array.isArray(b.items) ? b.items : [],
  };
  return out;
}

/* ---------------------------
   PUBLIC: fetch rails for a side
   GET /api/sections-v2?side=right
----------------------------*/
router.get("/sections-v2", async (req, res, next) => {
  try {
    const side = req.query.side === "left" ? "left" : "right";

    const docs = await PageSectionV2.find({ side, enabled: true })
      .sort({ order: 1 })
      .lean();

    const blocks = await Promise.all(
      docs.map(async (d) => {
        const base = {
          _id: d._id,
          key: d.key,
          title: d.title || "",
          type: d.type || d.template || "list_v1",
          side: d.side,
          order: d.order,
          config: d.config || {},
          ui: d.ui || {},
          items: [],
        };

        // Manual sections: return saved items as-is
        if (d.source?.type === "manual") {
          base.items = Array.isArray(d.items) ? d.items : [];
          return base;
        }

        // Query-based sections: fetch articles per query
        try {
          base.items = await fetchArticlesForSection(d);
        } catch (e) {
          // don't break the whole response if one block fails
          base.items = [];
        }
        return base;
      })
    );

    res.json(blocks);
  } catch (err) {
    next(err);
  }
});

/* ---------------------------
   ADMIN CRUD
----------------------------*/
router.get("/admin/sections-v2", async (_req, res, next) => {
  try {
    const rows = await PageSectionV2.find({})
      .sort({ side: 1, order: 1 })
      .lean();
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post("/admin/sections-v2", async (req, res) => {
  try {
    const payload = normalizeBody(req.body);
    if (!payload.key) return res.status(400).json({ error: "key is required" });
    if (!payload.type) return res.status(400).json({ error: "type is required" });

    const doc = await PageSectionV2.create(payload);
    res.json(doc);
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ error: "Duplicate key. Choose a unique key." });
    }
    console.error("SectionsV2 create error:", err);
    res.status(400).json({ error: err.message || "Bad request" });
  }
});

router.put("/admin/sections-v2/:id", async (req, res) => {
  try {
    const payload = normalizeBody(req.body);
    const doc = await PageSectionV2.findByIdAndUpdate(
      req.params.id,
      payload,
      { new: true, runValidators: true }
    );
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json(doc);
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ error: "Duplicate key. Choose a unique key." });
    }
    console.error("SectionsV2 update error:", err);
    res.status(400).json({ error: err.message || "Bad request" });
  }
});

router.delete("/admin/sections-v2/:id", async (req, res) => {
  try {
    await PageSectionV2.findByIdAndDelete(req.params.id);
  } catch (e) {
    // ignore
  }
  res.json({ ok: true });
});

module.exports = router;
