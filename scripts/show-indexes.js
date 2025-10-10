// backend/scripts/show-indexes.js
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { dbName: 'newsdb' });
    const db = mongoose.connection.db;

    const evIdx = await db.collection('analyticsevents').indexes();
    const dyIdx = await db.collection('analyticsdaily').indexes();

    console.log('\n== analyticsevents indexes ==');
    console.table(evIdx.map(i => ({ name: i.name, key: JSON.stringify(i.key) })));

    console.log('\n== analyticsdaily indexes ==');
    console.table(dyIdx.map(i => ({ name: i.name, key: JSON.stringify(i.key) })));

    await mongoose.disconnect();
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
