// backend/models/Comment.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const CommentSchema = new Schema({
  articleId: { type: Schema.Types.ObjectId, ref: 'Article', index: true, required: true },
  parentId: { type: Schema.Types.ObjectId, ref: 'Comment', default: null, index: true },
  authorName: { type: String, trim: true, maxlength: 80, required: true },
  authorEmailHash: { type: String, default: '' }, // store hash, not raw email (privacy)
  content: { type: String, trim: true, maxlength: 2000, required: true },
  status: { type: String, enum: ['pending', 'approved', 'spam'], default: 'pending', index: true },
  flags: {
    isAuthor: { type: Boolean, default: false }, // optional: badge for staff
  },
  meta: {
    ip: String,
    ua: String,
  },
}, { timestamps: true });

CommentSchema.index({ articleId: 1, createdAt: -1 });

module.exports = mongoose.model('Comment', CommentSchema);
