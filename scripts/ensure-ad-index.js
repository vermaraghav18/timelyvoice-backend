// backend/scripts/ensure-ad-index.js
const mongoose = require('mongoose');
require('dotenv').config();
const Ad = require('../src/models/Ad');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await Ad.syncIndexes();
  console.log('Ad indexes ensured.');
  await mongoose.disconnect();
})();
