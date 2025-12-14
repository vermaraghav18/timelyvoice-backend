// backend/src/routes/articles.js
const express = require('express');
const router = express.Router();

const ctrl = require('../controllers/article.controller');
const { withValidation } = require('../validators/withValidation');
const { ArticleCreateSchema, ArticleUpdateSchema } = require('../validators/article');
const { auth, permit } = require('../middleware/auth');
const { z } = require('zod');

function getFn(name, aliases = [], { required } = { required: false }) {
  const cand =
    (ctrl && typeof ctrl[name] === 'function' && ctrl[name]) ||
    aliases
      .map((a) => (ctrl && typeof ctrl[a] === 'function' && ctrl[a]) || null)
      .find(Boolean) ||
    null;

  if (!cand && required) {
    const available = Object.keys(ctrl || {}).sort().join(', ') || 'none';
    throw new Error(
      `[articles.routes] Missing required controller "${name}". ` +
        `Available exports: [${available}]. ` +
        `Please add/export "${name}" in backend/src/controllers/article.controller.js`
    );
  }
  return cand;
}

const list = getFn('list', ['search', 'index'], { required: true });
const getBySlug = getFn('getBySlug', ['readBySlug'], { required: true });
const create = getFn('create', [], { required: true });
const update = getFn('update', [], { required: true });

const read = getFn('read', ['get'], { required: false });
const publish = getFn('publish', [], { required: false });
const unpublish = getFn('unpublish', [], { required: false });
const softDelete = getFn('softDelete', ['remove', 'delete'], { required: false });

router.get(
  '/',
  withValidation(
    z.object({
      q: z.string().optional(),
      status: z.enum(['draft', 'published']).optional(),
      category: z.string().optional(),
      tag: z.string().optional(),
      page: z.coerce.number().min(1).optional(),
      limit: z.coerce.number().min(1).max(300).optional(),
    }),
    'query'
  ),
  list
);

router.get('/search', list);

router.post('/query', express.json(), (req, res, next) => {
  req.query = { ...(req.query || {}), ...(req.body || {}) };
  return list(req, res, next);
});

/* ============================================================
   PUBLIC READ ROUTES (ORDER MATTERS)
   ============================================================ */

/** Canonical slug route */
router.get(
  '/slug/:slug',
  withValidation(z.object({ slug: z.string().min(1) }), 'params'),
  getBySlug
);

/** ID route ONLY for real Mongo ObjectId values */
if (read) {
  router.get('/:id([0-9a-fA-F]{24})', read);
}

/** Slug fallback: now /api/articles/<slug> works */
router.get(
  '/:slug',
  withValidation(z.object({ slug: z.string().min(1) }), 'params'),
  getBySlug
);

/* ============================================================
   AUTH ROUTES
   ============================================================ */

router.post(
  '/',
  auth,
  permit(['author', 'editor', 'admin']),
  withValidation(ArticleCreateSchema),
  create
);

router.patch(
  '/:id',
  auth,
  permit(['author', 'editor', 'admin']),
  withValidation(ArticleUpdateSchema),
  update
);

if (publish) router.post('/:id/publish', auth, permit(['editor', 'admin']), publish);
if (unpublish) router.post('/:id/unpublish', auth, permit(['editor', 'admin']), unpublish);

if (softDelete) router.delete('/:id', auth, permit(['admin']), softDelete);

module.exports = router;
