const Category = require('../src/models/Category');
const Article = require('../src/models/Article');

async function migrate() {
  const cursor = Article.find({}).cursor();
  let count = 0;

  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    let cat = null;

    // Resolve category safely
    if (doc.category) {
      cat = await Category.findOne({
        $or: [
          { _id: doc.category },
          { slug: String(doc.category).toLowerCase() },
          { name: new RegExp(`^${doc.category}$`, 'i') }
        ]
      }).lean();
    }

    if (!cat) continue;

    const slug = String(cat.slug || '').toLowerCase();
    if (!slug) continue;

    await Article.updateOne(
      { _id: doc._id },
      {
        $set: {
          category: cat.name,
          categorySlug: slug
        }
      }
    );

    if (++count % 100 === 0) {
      console.log(`… fixed ${count} articles`);
    }
  }

  console.log(`✅ CategorySlug fix complete: ${count} articles`);
  process.exit(0);
}

migrate().catch(err => {
  console.error(err);
  process.exit(1);
});
