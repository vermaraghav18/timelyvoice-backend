// backend/src/models/AdminSetting.js
const mongoose = require("mongoose");

const AdminSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AdminSetting", AdminSettingSchema);
