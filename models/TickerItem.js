// backend/models/TickerItem.js
const mongoose = require('mongoose');

const TickerItemSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['stock', 'weather', 'note'],
      default: 'note',
      index: true,
    },
    label: {
      // e.g., "NIFTY", "Sensex", "Delhi", "AQI"
      type: String,
      required: true,
      trim: true,
      maxlength: 50,
    },
    value: {
      // e.g., "+0.7%", "35°C", "Moderate"
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    order: {
      type: Number,
      default: 0,
      index: true,
    },
    active: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true, // createdAt, updatedAt
    versionKey: false,
  }
);

TickerItemSchema.index({ active: 1, order: 1, createdAt: -1 });

module.exports = mongoose.model('TickerItem', TickerItemSchema);
