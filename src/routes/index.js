const router = require('express').Router();
router.use('/articles', require('./articles'));
router.use('/categories', require('./categories')); // implement similar to articles
router.use('/tags', require('./tags'));
router.use('/media', require('./media'));
module.exports = router;
