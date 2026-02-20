// backend/src/controllers/admin.prompt.controller.js
const AdminSetting = require("../models/AdminSetting");

const KEY = "dailyPrompt";

exports.getPrompt = async (req, res) => {
  try {
    const doc = await AdminSetting.findOne({ key: KEY }).lean();
    return res.json({ ok: true, prompt: doc?.value || "" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Failed to load prompt" });
  }
};

exports.savePrompt = async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || "");
    const doc = await AdminSetting.findOneAndUpdate(
      { key: KEY },
      { value: prompt },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    return res.json({ ok: true, prompt: doc?.value || "" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Failed to save prompt" });
  }
};
