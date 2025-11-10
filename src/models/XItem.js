const mongoose = require('mongoose');

const xItemSchema = new mongoose.Schema({
  handle: { type: String, index: true },
  xId: { type: String, unique: true, index: true }, // tweet id
  text: { type: String, default: '' },
  tweetedAt: { type: Date, index: true },
  urls: { type: [String], default: [] },
  media: { type: [Object], default: [] },

  // Manual pipeline states: new -> extracted -> generated -> drafted
  status: { type: String, enum: ['new', 'extracted', 'generated', 'drafted'], default: 'new', index: true },

  // Step data
  extractedText: { type: String, default: '' },    // after Extract
  generated: {
    title: String,
    summary: String,
    body: String,
    tags: [String],
    category: String
  },                                               // after Generate

  // Link to created article (after Draft)
  articleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Article' }
}, { timestamps: true });

module.exports = mongoose.models.XItem || mongoose.model('XItem', xItemSchema);
