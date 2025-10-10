const express = require('express');
const crypto = require('crypto');
const router = express.Router();

module.exports = ({ Subscriber }, { requireAuthAdmin }) => {
  function emailHash(email) {
    return crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  }
  function mask(email) {
    const [u, d] = email.split('@');
    return `${u[0]}***@${d[0]}***.${d.split('.').pop()}`;
  }

  // POST /newsletter/subscribe
  router.post('/newsletter/subscribe', async (req, res) => {
    const { email } = req.body || {};
    if (!email || !/\S+@\S+\.\S+/.test(email)) return res.status(400).json({ error: 'Bad email' });
    const hash = emailHash(email);
    const token = crypto.randomBytes(24).toString('hex');

    const doc = await Subscriber.findOneAndUpdate(
      { emailHash: hash },
      { $set: { emailMasked: mask(email), status: 'pending', token } },
      { upsert: true, new: true }
    );

    // TODO: send email via SendGrid/Mailchimp webhook: link to /newsletter/confirm?token=...
    // For now we just return token so you can test flow in dev.
    res.json({ ok: true, token });
  });

  // GET /newsletter/confirm?token=...
  router.get('/newsletter/confirm', async (req, res) => {
    const token = req.query.token || '';
    const sub = await Subscriber.findOne({ token });
    if (!sub) return res.status(400).send('Invalid token.');
    await Subscriber.updateOne({ _id: sub._id }, { $set: { status: 'confirmed' }, $unset: { token: 1 } });
    res.send('Subscription confirmed! You can close this tab.');
  });

  // Admin: list subscribers
  router.get('/api/admin/subscribers', requireAuthAdmin, async (req, res) => {
    const items = await Subscriber.find().sort({ createdAt: -1 }).limit(500).lean();
    res.json(items);
  });

  return router;
};
