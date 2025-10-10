const mongoose = require('mongoose');
const CategorySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 50 },
  slug: { type: String, required: true, trim: true, unique: true, index: true },
  description: { type: String, maxlength: 200 },
  type: { type: String, enum: ['topic','state','city'], default: 'topic', index: true }
}, { timestamps: true });

module.exports = mongoose.model('Category', CategorySchema);
