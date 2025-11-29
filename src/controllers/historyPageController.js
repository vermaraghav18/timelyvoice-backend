import HistoryPageConfig from "../models/HistoryPageConfig.js";

export const getPublicHistoryPage = async (req, res) => {
  try {
    const config = await HistoryPageConfig.findOne();
    return res.json(config || {});
  } catch (err) {
    console.error("History page fetch error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const getAdminHistoryPage = async (req, res) => {
  try {
    const config = await HistoryPageConfig.findOne();
    return res.json(config || {});
  } catch (err) {
    console.error("History admin fetch error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

export const updateHistoryPage = async (req, res) => {
  try {
    const body = req.body;

    const updated = await HistoryPageConfig.findOneAndUpdate(
      {},
      {
        heroTitle: body.heroTitle,
        heroDescription: body.heroDescription,
        heroImage: body.heroImage,
        sections: body.sections || [],
        timeline: body.timeline || [],
        updatedAt: Date.now()
      },
      { upsert: true, new: true }
    );

    res.json(updated);
  } catch (err) {
    console.error("History update error:", err);
    res.status(500).json({ error: "Server error" });
  }
};
