const mongoose = require('mongoose');
const { Schema } = mongoose;

const SubscriberSchema = new Schema({
  emailHash: { type: String, unique: true, index: true },
  emailMasked: { type: String }, // e.g., j***@g***.com (for admin viewing)
  status: { type: String, enum: ['pending','confirmed','unsubscribed'], default: 'pending', index: true },
  token: { type: String, index: true }, // confirmation token
}, { timestamps: true });

module.exports = mongoose.model('Subscriber', SubscriberSchema);
