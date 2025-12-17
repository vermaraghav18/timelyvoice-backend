require('dotenv').config();
const mongoose = require('mongoose');
const slugify = require('slugify');

const Article = require('../src/models/Article');
const Category = require('../src/models/Category');

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      dbName: 'newsdb',
    });

    console.log('✅ Connected to MongoDB');

    const cursor = Article.find({
      $or: [
        { categorySlug: { $exists: false } },
        { categorySlug: '' }
      ]
    }).cursor();

    let updated = 0;

    for await (const article of cursor) {
      let categoryName = article.category;
      let categorySlug = '';

      if (typeof categoryName === 'string' && categoryName.trim()) {
        const found = await Category.findOne({
          $or: [
            { slug: categoryName.toLowerCase() },
            { name: new RegExp(`^${categoryName}$`, 'i') }
          ]
        }).select('name slug').lean();

        if (found) {
          categoryName = found.name;
          categorySlug = found.slug;
        } else {
          categorySlug = slugify(categoryName, { lower: true, strict: true }) || 'general';
        }
      } else {
        categoryName = 'General';
        categorySlug = 'general';
      }

      await Article.updateOne(
        { _id: article._id },
        {
          $set: {
            category: categoryName,
            categorySlug
          }
        }
      );

      updated++;
      if (updated % 50 === 0) {
        console.log(`… updated ${updated} articles`);
      }
    }

    console.log(`🎉 Migration complete. Updated ${updated} articles.`);
    process.exit(0);

  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
})();
