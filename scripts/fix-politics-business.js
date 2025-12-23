/**
 * Fix legacy Article categories:
 * - Move any Politics-ish articles -> India
 * - Move any Business-ish articles -> Finance
 * - Print before/after counts so you can confirm it worked
 *
 * Run:
 *   cd backend
 *   node scripts/fix-politics-business.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Article = require("../src/models/Article");

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("Missing MONGO_URI (or MONGODB_URI).");

  await mongoose.connect(uri);
  console.log("✅ Connected to MongoDB");

  // 1) Show what is actually stored in Articles
  const top = await Article.aggregate([
    {
      $project: {
        category: { $ifNull: ["$category", ""] },
        categorySlug: { $ifNull: ["$categorySlug", ""] },
      },
    },
    {
      $group: {
        _id: { category: "$category", categorySlug: "$categorySlug" },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
    { $limit: 30 },
  ]);

  console.log("\n== Top 30 category pairs in Articles (before) ==");
  for (const row of top) {
    const c = row._id.category || "(empty)";
    const s = row._id.categorySlug || "(empty)";
    console.log(`${String(row.count).padStart(5)}  category="${c}"  slug="${s}"`);
  }

  // 2) Update Politics-ish -> India (very forgiving matches)
  const politicsFilter = {
    $or: [
      { categorySlug: { $regex: "politic", $options: "i" } },
      { category: { $regex: "politic", $options: "i" } },
      { category: { $regex: "govern", $options: "i" } }, // covers "Governance"
    ],
  };

  const politicsUpdate = {
    $set: { category: "India", categorySlug: "india" },
  };

  const rIndia = await Article.updateMany(politicsFilter, politicsUpdate);

  // 3) Update Business-ish -> Finance
  const businessFilter = {
    $or: [
      { categorySlug: { $regex: "business", $options: "i" } },
      { category: { $regex: "business", $options: "i" } },
      { category: { $regex: "econom", $options: "i" } }, // optional: economy
      { categorySlug: { $regex: "econom", $options: "i" } },
    ],
  };

  const businessUpdate = {
    $set: { category: "Finance", categorySlug: "finance" },
  };

  const rFin = await Article.updateMany(businessFilter, businessUpdate);

  console.log("\n== Updates done ==");
  console.log(`Politics-ish -> India:   matched ${rIndia.matchedCount || 0}, modified ${rIndia.modifiedCount || 0}`);
  console.log(`Business-ish -> Finance: matched ${rFin.matchedCount || 0}, modified ${rFin.modifiedCount || 0}`);

  // 4) Quick after check: how many India now?
  const indiaCount = await Article.countDocuments({ categorySlug: "india" });
  const financeCount = await Article.countDocuments({ categorySlug: "finance" });
  console.log("\n== After counts ==");
  console.log(`India articles:   ${indiaCount}`);
  console.log(`Finance articles: ${financeCount}`);

  console.log("\n✅ Done.");
}

main()
  .catch((e) => {
    console.error("❌ fix-politics-business failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await mongoose.disconnect(); } catch {}
  });
