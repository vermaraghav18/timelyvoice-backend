
// backend/src/routes/planImage.routes.js
const router = require('express').Router();

// If your service exports a different name (e.g. pickHeroImage),
// change the import accordingly.
const { chooseHeroImage } = require('../services/imagePicker');

/**
 * POST /api/articles/plan-image
 * Body: { title?, summary?, category?, tags?, slug? }
 * Returns: { publicId, url, why }
 *
 * This lets the admin preview what hero image the backend would pick
 * before saving the article.
 */
router.post('/plan-image', async (req, res) => {
  try {
    const {
      title = '',
      summary = '',
      category = '',
      tags = [],
      slug = ''
    } = req.body || {};

    // Delegate to your existing image picker service
    const pick = await chooseHeroImage({ title, summary, category, tags, slug });

    return res.json({
      publicId: pick?.publicId || null,
      url: pick?.url || null,
      why: pick?.why || null
    });
  } catch (err) {
    console.error('plan-image error', err);
    return res.status(500).json({ error: 'plan-image failed' });
  }
});

module.exports = router;
