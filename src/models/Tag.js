const mongoose = require('mongoose');
const TagSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 40 },
  slug: { type: String, required: true, trim: true, unique: true, index: true }
}, { timestamps: true });

module.exports = mongoose.model('Tag', TagSchema);
