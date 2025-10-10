const mongoose = require('mongoose');
const MediaSchema = new mongoose.Schema({
  url: { type: String, required: true },
  mime: { type: String, required: true },
  size: { type: Number, required: true }, // bytes
  width: Number,
  height: Number,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

module.exports = mongoose.model('Media', MediaSchema);
    