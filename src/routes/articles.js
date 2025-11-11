// backend/src/routes/articles.js
const express = require('express');
const router = express.Router();

const ctrl = require('../controllers/article.controller');
const { withValidation } = require('../validators/withValidation');
const { ArticleCreateSchema, ArticleUpdateSchema } = require('../validators/article');
const { auth, permit } = require('../middleware/auth'); // we added this file earlier
const { z } = require('zod');

/**
 * Helper to resolve controller functions without crashing the app.
 * If required=true and the fn is missing, we throw (only for hard-required routes).
 * For optional routes, we return null and simply don't mount that route.
 */
function getFn(name, aliases = [], { required } = { required: false }) {
  const cand =
    (ctrl && typeof ctrl[name] === 'function' && ctrl[name]) ||
    aliases.map(a => (ctrl && typeof ctrl[a] === 'function' && ctrl[a]) || null).find(Boolean) ||
    null;

  if (!cand && required) {
    const available = Object.keys(ctrl || {}).sort().join(', ') || 'none';
    throw new Error(
      `[articles.routes] Missing required controller "${name}". ` +
      `Available exports: [${available}]. ` +
      `Please add/export "${name}" in backend/src/controllers/article.controller.js`
    );
  }
  return cand; // function or null
}

/** Required handlers (these are used by the public site) */
const list      = getFn('list',      ['search', 'index'], { required: true });
const getBySlug = getFn('getBySlug', ['readBySlug'],       { required: true });
const create    = getFn('create',    [],                   { required: true });
const update    = getFn('update',    [],                   { required: true });

/** Optional handlers — only mount routes if they exist */
const read       = getFn('read',       ['get'],              { required: false });
const publish    = getFn('publish',    [],                   { required: false });
const unpublish  = getFn('unpublish',  [],                   { required: false });
const softDelete = getFn('softDelete', ['remove', 'delete'], { required: false });

/**
 * List articles (public)
 * Supports: q, status, category, tag, page, limit
 */
router.get(
  '/',
  withValidation(
    z.object({
      q: z.string().optional(),
      status: z.enum(['draft', 'published']).optional(),
      category: z.string().optional(),
      tag: z.string().optional(),
      page: z.coerce.number().min(1).optional(),
      limit: z.coerce.number().min(1).max(100).optional(),
    }),
    'query'
  ),
  list
);

/** Simple alias so /api/articles/search works like list() */
router.get('/search', list);

/**
 * Allow POST body for list-like queries (for HomeV2)
 * Body fields (q, tag, category, limit, page, status, etc.) are merged into req.query
 */
router.post('/query', express.json(), (req, res, next) => {
  req.query = { ...(req.query || {}), ...(req.body || {}) };
  return list(req, res, next);
});

/** 👇 Public slug reader — MUST be before '/:id' */
router.get(
  '/slug/:slug',
  withValidation(z.object({ slug: z.string().min(1) }), 'params'),
  getBySlug
);

/** Optional: Read by id (public) */
if (read) {
  router.get('/:id', read);
}

/** Create (auth required) */
router.post(
  '/',
  auth,
  permit(['author', 'editor', 'admin']),
  withValidation(ArticleCreateSchema),
  create
);

/** Update (auth required) */
router.patch(
  '/:id',
  auth,
  permit(['author', 'editor', 'admin']),
  withValidation(ArticleUpdateSchema),
  update
);

/** Optional: Publish / Unpublish (auth required) */
if (publish)   router.post('/:id/publish',   auth, permit(['editor', 'admin']), publish);
if (unpublish) router.post('/:id/unpublish', auth, permit(['editor', 'admin']), unpublish);

/** Optional: Soft delete (auth required) */
if (softDelete) router.delete('/:id', auth, permit(['admin']), softDelete);

module.exports = router;
