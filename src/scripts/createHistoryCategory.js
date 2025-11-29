// backend/src/scripts/createHistoryCategory.js

require('dotenv').config();
const mongoose = require('mongoose');

// ✅ Correct path: this file is in src/scripts, models are in src/models
const Category = require('../models/Category');

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('Missing MONGO_URI or MONGODB_URI in .env');
    process.exit(1);
  }

  // ✅ Use the same DB settings as backend/index.js
  await mongoose.connect(uri, { dbName: 'newsdb', autoIndex: true });
  console.log('Connected to Mongo (newsdb)');

  const update = {
    name: 'History',
    slug: 'history',
    type: 'topic', // same enum as other main categories
    description: 'History articles, timelines and analysis.'
  };

  const res = await Category.updateOne(
    { slug: 'history' },    // find by slug
    { $set: update },       // set/overwrite fields
    { upsert: true }        // create if not found
  );

  console.log('Upsert result:', res);

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
