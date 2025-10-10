const router = require('express').Router();
const ctrl = require('../controllers/article.controller');
const { withValidation } = require('../validators/withValidation');
const { ArticleCreateSchema, ArticleUpdateSchema } = require('../validators/article');
const { auth, permit } = require('../middleware/auth'); // step 2 will fill this

router.get('/', withValidation(
  // light query validation inline
  require('zod').z.object({
    q: require('zod').z.string().optional(),
    status: require('zod').z.enum(['draft','published']).optional(),
    category: require('zod').z.string().optional(),
    tag: require('zod').z.string().optional(),
    page: require('zod').z.coerce.number().min(1).optional(),
    limit: require('zod').z.coerce.number().min(1).max(100).optional(),
  }), 'query'), ctrl.list);

router.get('/:id', ctrl.read);

router.post('/', auth, permit(['author','editor','admin']),
  withValidation(ArticleCreateSchema), ctrl.create);

router.patch('/:id', auth, permit(['author','editor','admin']),
  withValidation(ArticleUpdateSchema), ctrl.update);

router.post('/:id/publish', auth, permit(['editor','admin']), ctrl.publish);
router.post('/:id/unpublish', auth, permit(['editor','admin']), ctrl.unpublish);
router.delete('/:id', auth, permit(['admin']), ctrl.softDelete);

module.exports = router;
