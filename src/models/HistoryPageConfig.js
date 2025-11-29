import mongoose from "mongoose";

const SectionSchema = new mongoose.Schema({
  title: { type: String, default: "" },
  layout: { type: String, default: "grid" }, // grid, slider, cards, timeline, list
  articleIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Article" }]
});

const TimelineSchema = new mongoose.Schema({
  year: Number,
  title: String,
  description: String,
  image: String
});

const HistoryPageConfigSchema = new mongoose.Schema({
  heroTitle: { type: String, default: "History" },
  heroDescription: { type: String, default: "" },
  heroImage: { type: String, default: "" },

  sections: [SectionSchema],
  timeline: [TimelineSchema],

  updatedAt: { type: Date, default: Date.now }
});

export default mongoose.model("HistoryPageConfig", HistoryPageConfigSchema);
