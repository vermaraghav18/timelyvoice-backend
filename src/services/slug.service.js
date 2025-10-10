const slugify = require('slugify');
const Article = require('../models/Article');

exports.toSlug = (text) => slugify(text, { lower: true, strict: true });

exports.ensureUniqueArticleSlug = async (title, categoryId) => {
  const base = exports.toSlug(title);
  let slug = base, i = 1;
  while (await Article.exists({ slug, category: categoryId })) {
    slug = `${base}-${i++}`;
  }
  return slug;
};
