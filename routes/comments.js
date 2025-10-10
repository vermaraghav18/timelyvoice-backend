// backend/routes/comments.js
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

module.exports = ({ Article, Comment }, { requireAuthOptional, requireAuthAdmin }) => {
  const createLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 }); // 60/15min per IP

  // Helper: naive spam check (expand later)
  function looksSpammy(text='') {
    const bad = [/https?:\/\//i, /\bviagra\b/i, /\bcasino\b/i];
    return bad.some(r => r.test(text));
  }

  // List approved comments for an article by slug
  router.get('/api/public/articles/:slug/comments', async (req, res) => {
    const art = await Article.findOne({ slug: req.params.slug }).select('_id').lean();
    if (!art) return res.status(404).json({ error: 'Article not found' });
    const items = await Comment.find({ articleId: art._id, status: 'approved' })
      .sort({ createdAt: 1 })
      .lean();
    res.json(items);
  });

  // Create comment (public)
  router.post('/api/public/articles/:slug/comments', createLimiter, requireAuthOptional, async (req, res) => {
    const { authorName, authorEmail, content, parentId } = req.body || {};
    if (!authorName || !content) return res.status(400).json({ error: 'Missing fields' });

    const art = await Article.findOne({ slug: req.params.slug }).select('_id').lean();
    if (!art) return res.status(404).json({ error: 'Article not found' });

    // spam heuristics
    const status = looksSpammy(content) ? 'spam' : 'pending';
    const authorEmailHash = authorEmail ? crypto.createHash('sha256').update(authorEmail.trim().toLowerCase()).digest('hex') : '';

    const doc = await Comment.create({
      articleId: art._id,
      parentId: parentId || null,
      authorName, authorEmailHash, content,
      status,
      meta: { ip: req.ip, ua: req.get('user-agent') }
    });

    res.json({ ok: true, id: doc._id, status });
  });

  // Admin: list (filter by status)
  router.get('/api/admin/comments', requireAuthAdmin, async (req, res) => {
    const status = (req.query.status || 'pending');
    const items = await Comment.find(status === 'all' ? {} : { status })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    res.json(items);
  });

  // Admin: approve/reject/delete
  router.patch('/api/admin/comments/:id', requireAuthAdmin, async (req, res) => {
    const { action } = req.body || {};
    if (!['approve','pending','spam'].includes(action)) return res.status(400).json({ error: 'Bad action' });
    await Comment.findByIdAndUpdate(req.params.id, { $set: { status: action } });
    res.json({ ok: true });
  });

  router.delete('/api/admin/comments/:id', requireAuthAdmin, async (req, res) => {
    await Comment.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  });

  return router;
};
