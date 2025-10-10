// backend/routes/ticker.js
const express = require('express');
const router = express.Router();
const TickerItem = require('../models/TickerItem');

// GET /api/ticker
// Public list (active only). Use ?all=1 to fetch all for admin.
router.get('/', async (req, res) => {
  try {
    const includeAll = req.query.all === '1' || req.query.all === 'true';
    const filter = includeAll ? {} : { active: true };
    const items = await TickerItem.find(filter)
      .sort({ active: -1, order: 1, createdAt: -1 })
      .lean();
    res.json(items);
  } catch (err) {
    console.error('[ticker] list error', err);
    res.status(500).json({ message: 'Failed to load ticker items' });
  }
});

// POST /api/ticker
// Create a new ticker item
router.post('/', async (req, res) => {
  try {
    const {
      type = 'note',
      label,
      value,
      order = 0,
      active = true,
    } = req.body || {};

    if (!label || !value) {
      return res.status(400).json({ message: 'label and value are required' });
    }

    const doc = await TickerItem.create({
      type,
      label: String(label).trim(),
      value: String(value).trim(),
      order: Number(order) || 0,
      active: Boolean(active),
    });

    res.status(201).json(doc);
  } catch (err) {
    console.error('[ticker] create error', err);
    res.status(500).json({ message: 'Failed to create ticker item' });
  }
});

// PATCH /api/ticker/:id
// Update an existing ticker item
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = {};
    ['type', 'label', 'value', 'order', 'active'].forEach((k) => {
      if (k in req.body) updates[k] = req.body[k];
    });
    if (typeof updates.label === 'string') updates.label = updates.label.trim();
    if (typeof updates.value === 'string') updates.value = updates.value.trim();
    if ('order' in updates) updates.order = Number(updates.order) || 0;

    const doc = await TickerItem.findByIdAndUpdate(id, updates, { new: true });
    if (!doc) return res.status(404).json({ message: 'Not found' });
    res.json(doc);
  } catch (err) {
    console.error('[ticker] patch error', err);
    res.status(500).json({ message: 'Failed to update ticker item' });
  }
});

// DELETE /api/ticker/:id
// Remove a ticker item
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await TickerItem.findByIdAndDelete(id);
    if (!doc) return res.status(404).json({ message: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[ticker] delete error', err);
    res.status(500).json({ message: 'Failed to delete ticker item' });
  }
});

module.exports = router;
