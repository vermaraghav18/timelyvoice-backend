const mongoose = require('mongoose');
const UserSchema = new mongoose.Schema({
  name:  { type: String, required: true },
  email: { type: String, required: true, lowercase: true, unique: true, index: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['author','editor','admin'], default: 'author', index: true }
}, { timestamps: true });

module.exports = mongoose.model('User', UserSchema);
