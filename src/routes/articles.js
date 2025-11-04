const router = require('express').Router();
const ctrl = require('../controllers/article.controller');
const { withValidation } = require('../validators/withValidation');
const { ArticleCreateSchema, ArticleUpdateSchema } = require('../validators/article');
const { auth, permit } = require('../middleware/auth');
const { z } = require('zod');

router.get(
  '/',
  withValidation(
    z.object({
      q: z.string().optional(),
      status: z.enum(['draft','published']).optional(),
      category: z.string().optional(),
      tag: z.string().optional(),
      page: z.coerce.number().min(1).optional(),
      limit: z.coerce.number().min(1).max(100).optional(),
    }),
    'query'
  ),
  ctrl.list
);

/** 👇👇 NEW: public slug reader — MUST be before '/:id' 👇👇 */
router.get(
  '/slug/:slug',
  withValidation(z.object({ slug: z.string().min(1) }), 'params'),
  ctrl.getBySlug
);

router.get('/:id', ctrl.read);

router.post(
  '/',
  auth,
  permit(['author','editor','admin']),
  withValidation(ArticleCreateSchema),
  ctrl.create
);

router.patch(
  '/:id',
  auth,
  permit(['author','editor','admin']),
  withValidation(ArticleUpdateSchema),
  ctrl.update
);

router.post('/:id/publish',   auth, permit(['editor','admin']), ctrl.publish);
router.post('/:id/unpublish', auth, permit(['editor','admin']), ctrl.unpublish);
router.delete('/:id',         auth, permit(['admin']),          ctrl.softDelete);

module.exports = router;
