// backend/routes/breaking.js
const express = require('express');
const router = express.Router();
const BreakingNews = require('../models/BreakingNews');

// GET /api/breaking
// Public list by default (active only). Pass ?all=1 to get all (for admin UIs).
router.get('/', async (req, res) => {
  try {
    const includeAll = req.query.all === '1' || req.query.all === 'true';
    const filter = includeAll ? {} : { active: true };
    const items = await BreakingNews.find(filter)
      .sort({ active: -1, priority: 1, createdAt: -1 })
      .lean();
    res.json(items);
  } catch (err) {
    console.error('[breaking] list error', err);
    res.status(500).json({ message: 'Failed to load breaking news' });
  }
});

// POST /api/breaking
// Create a new breaking item
router.post('/', async (req, res) => {
  try {
    const { headline, url = '', active = true, priority = 0 } = req.body || {};
    if (!headline || !headline.trim()) {
      return res.status(400).json({ message: 'headline is required' });
    }
    const doc = await BreakingNews.create({
      headline: headline.trim(),
      url: url.trim(),
      active: Boolean(active),
      priority: Number(priority) || 0,
    });
    res.status(201).json(doc);
  } catch (err) {
    console.error('[breaking] create error', err);
    res.status(500).json({ message: 'Failed to create breaking item' });
  }
});

// PATCH /api/breaking/:id
// Update an existing breaking item
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = {};
    ['headline', 'url', 'active', 'priority'].forEach((k) => {
      if (k in req.body) updates[k] = req.body[k];
    });
    if (typeof updates.headline === 'string') updates.headline = updates.headline.trim();
    if (typeof updates.url === 'string') updates.url = updates.url.trim();
    if ('priority' in updates) updates.priority = Number(updates.priority) || 0;

    const doc = await BreakingNews.findByIdAndUpdate(id, updates, { new: true });
    if (!doc) return res.status(404).json({ message: 'Not found' });
    res.json(doc);
  } catch (err) {
    console.error('[breaking] patch error', err);
    res.status(500).json({ message: 'Failed to update breaking item' });
  }
});

// DELETE /api/breaking/:id
// Remove a breaking item
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await BreakingNews.findByIdAndDelete(id);
    if (!doc) return res.status(404).json({ message: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[breaking] delete error', err);
    res.status(500).json({ message: 'Failed to delete breaking item' });
  }
});

module.exports = router;
