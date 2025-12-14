// backend/src/routes/articles.js
const express = require('express');
const router = express.Router();

const ctrl = require('../controllers/article.controller');
const { withValidation } = require('../validators/withValidation');
const { ArticleCreateSchema, ArticleUpdateSchema } = require('../validators/article');
const { auth, permit } = require('../middleware/auth');
const { z } = require('zod');

/**
 * Helper to resolve controller functions without crashing the app.
 * If required=true and the fn is missing, we throw (only for hard-required routes).
 * For optional routes, we return null and simply don't mount that route.
 */
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

/** Required handlers (public site depends on these) */
const list = getFn('list', ['search', 'index'], { required: true });
const getBySlug = getFn('getBySlug', ['readBySlug'], { required: true });
const create = getFn('create', [], { required: true });
const update = getFn('update', [], { required: true });

/** Optional handlers */
const read = getFn('read', ['get'], { required: false });
const publish = getFn('publish', [], { required: false });
const unpublish = getFn('unpublish', [], { required: false });
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
      limit: z.coerce.number().min(1).max(300).optional(),
    }),
    'query'
  ),
  list
);

/** Alias so /api/articles/search behaves like list() */
router.get('/search', list);

/**
 * Allow POST body for list-like queries (HomeV2)
 */
router.post('/query', express.json(), (req, res, next) => {
  req.query = { ...(req.query || {}), ...(req.body || {}) };
  return list(req, res, next);
});

/* ============================================================
   PUBLIC ARTICLE READ ROUTES (ORDER MATTERS)
   ============================================================ */

/** Canonical slug route (used by SSR + API) */
router.get(
  '/slug/:slug',
  withValidation(z.object({ slug: z.string().min(1) }), 'params'),
  getBySlug
);

/**
 * ✅ PUBLIC SLUG ALIAS
 * This FIXES the SPA route:
 *   /api/articles/<slug>
 * without breaking ID-based routes.
 */
router.get(
  '/:slug',
  withValidation(z.object({ slug: z.string().min(1) }), 'params'),
  getBySlug
);

/** Optional: Read by ID (public) — must stay AFTER slug routes */
if (read) {
  router.get('/:id', read);
}

/* ============================================================
   AUTHENTICATED ROUTES
   ============================================================ */

/** Create article */
router.post(
  '/',
  auth,
  permit(['author', 'editor', 'admin']),
  withValidation(ArticleCreateSchema),
  create
);

/** Update article */
router.patch(
  '/:id',
  auth,
  permit(['author', 'editor', 'admin']),
  withValidation(ArticleUpdateSchema),
  update
);

/** Publish / Unpublish */
if (publish)
  router.post('/:id/publish', auth, permit(['editor', 'admin']), publish);

if (unpublish)
  router.post('/:id/unpublish', auth, permit(['editor', 'admin']), unpublish);

/** Soft delete */
if (softDelete)
  router.delete('/:id', auth, permit(['admin']), softDelete);

module.exports = router;
