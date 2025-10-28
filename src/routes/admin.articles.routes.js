// backend/src/routes/admin.articles.routes.js
// Admin routes for listing, previewing, editing and publishing Article drafts

const express = require('express');
const router = express.Router();

// ✅ Adjust the path if your model lives elsewhere
const Article = require('../models/Article');

// ────────────────────────────────────────────────────────────────────────────────
// GET /api/admin/articles/drafts
// List only items that are *not* published yet (drafts)
// ────────────────────────────────────────────────────────────────────────────────
router.get('/drafts', async (req, res) => {
  try {
    // Treat as "draft" if status==='draft' OR status missing
    // (also exclude anything that already has publishedAt)
    const q = {
      $and: [
        { $or: [{ status: 'draft' }, { status: { $exists: false } }] },
        { $or: [{ publishedAt: { $exists: false } }, { publishedAt: null }] }
      ]
    };

    // Optional: filter AI-only drafts
    // q.source = 'automation';

    const drafts = await Article.find(q)
      .select('_id title category slug status summary imageUrl createdAt updatedAt')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    res.json(drafts);
  } catch (err) {
    console.error('[admin.articles] drafts error', err);
    res.status(500).json({ error: 'failed_to_list_drafts' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// GET /api/admin/articles/:id
// Fetch a single article for preview/edit
// ────────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const article = await Article.findById(req.params.id).lean();
    if (!article) return res.status(404).json({ error: 'not_found' });
    res.json(article);
  } catch (err) {
    console.error('[admin.articles] get error', err);
    res.status(500).json({ error: 'failed_to_get_article' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/articles/:id
// Edit fields; if status becomes 'published', set publishedAt
// ────────────────────────────────────────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const allowed = ['title', 'category', 'summary', 'imageUrl', 'status'];
    const patch = {};

    for (const k of allowed) {
      if (req.body[k] !== undefined) patch[k] = req.body[k];
    }

    // If the admin marks this as published, add publishedAt
    if (patch.status === 'published') {
      patch.publishedAt = new Date();
    }

    const updated = await Article.findByIdAndUpdate(
      req.params.id,
      { $set: patch },
      { new: true }
    ).lean();

    if (!updated) return res.status(404).json({ error: 'not_found' });
    res.json(updated);
  } catch (err) {
    console.error('[admin.articles] patch error', err);
    res.status(500).json({ error: 'failed_to_update_article' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// POST /api/admin/articles/:id/publish
// Simple publish endpoint (no body required)
// ────────────────────────────────────────────────────────────────────────────────
router.post('/:id/publish', async (req, res) => {
  try {
    const updated = await Article.findByIdAndUpdate(
      req.params.id,
      { $set: { status: 'published', publishedAt: new Date() } },
      { new: true }
    ).lean();

    if (!updated) return res.status(404).json({ error: 'not_found' });
    res.json(updated);
  } catch (err) {
    console.error('[admin.articles] publish error', err);
    res.status(500).json({ error: 'failed_to_publish' });
  }
});

module.exports = router;
