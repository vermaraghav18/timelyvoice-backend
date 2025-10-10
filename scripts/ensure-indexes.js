// backend/scripts/ensure-indexes.js
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  try {
    const uri = process.env.MONGO_URI;
    await mongoose.connect(uri, { dbName: 'newsdb' });

    const db = mongoose.connection.db;

    await db.collection('analyticsevents').createIndex({ createdAt: -1 });
    await db.collection('analyticsevents').createIndex({ type: 1, createdAt: -1 });
    await db.collection('analyticsevents').createIndex({ path: 1, createdAt: -1 });
    await db.collection('analyticsevents').createIndex({ visitorId: 1, createdAt: -1 });
    await db.collection('analyticsevents').createIndex({ 'geo.country': 1, createdAt: -1 });
    await db.collection('analyticsevents').createIndex({
      'utm.source': 1, 'utm.medium': 1, 'utm.campaign': 1, createdAt: -1
    });

    await db.collection('analyticsdaily').createIndex({ date: 1 }, { unique: true });
    await db.collection('analyticsdaily').createIndex({ generatedAt: -1 });

    console.log('✅ Indexes ensured');
    process.exit(0);
  } catch (e) {
    console.error('❌ ensure-indexes failed:', e);
    process.exit(1);
  }
})();
