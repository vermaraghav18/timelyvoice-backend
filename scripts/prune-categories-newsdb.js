require("dotenv").config();
const mongoose = require("mongoose");
const Category = require("../src/models/Category");
const Article = require("../src/models/Article");

const ALLOWED = [
  { name: "India", slug: "india" },
  { name: "World", slug: "world" },
  { name: "Health", slug: "health" },
  { name: "Finance", slug: "finance" },
  { name: "History", slug: "history" },
  { name: "New Delhi", slug: "new-delhi" },
  { name: "Punjab", slug: "punjab" },
  { name: "Entertainment", slug: "entertainment" },
  { name: "General", slug: "general" },
];

const allowedSlugs = new Set(ALLOWED.map((c) => c.slug));

function slugify(v) {
  return String(v || "")
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeLegacySlug(s) {
  const x = slugify(s);
  if (x === "politics") return "india";
  if (x === "business") return "finance";
  return x;
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("Missing MONGO_URI / MONGODB_URI");

  await mongoose.connect(uri, { dbName: "newsdb" });
  console.log("✅ Connected to MongoDB DB =", mongoose.connection.name);

  console.log("\n== Ensuring allowed categories exist in newsdb ==");
  for (const c of ALLOWED) {
    const exists = await Category.findOne({ slug: c.slug });
    if (!exists) {
      await Category.create({ name: c.name, slug: c.slug, type: "topic" });
      console.log(`- created: ${c.name} (${c.slug})`);
    } else {
      console.log(`- kept: ${exists.name} (${exists.slug})`);
    }
  }

  console.log("\n== Updating Articles: Politics -> India, Business -> Finance (newsdb) ==");

  // Robust: update BOTH categorySlug and category name string if they contain politics/business
  const rPol = await Article.updateMany(
    {
      $or: [
        { categorySlug: { $regex: "politic", $options: "i" } },
        { category: { $regex: "politic", $options: "i" } },
      ],
    },
    { $set: { categorySlug: "india", category: "India" } }
  );

  const rBus = await Article.updateMany(
    {
      $or: [
        { categorySlug: { $regex: "business", $options: "i" } },
        { category: { $regex: "business", $options: "i" } },
      ],
    },
    { $set: { categorySlug: "finance", category: "Finance" } }
  );

  console.log(`- Politics -> India: matched ${rPol.matchedCount || 0}, modified ${rPol.modifiedCount || 0}`);
  console.log(`- Business -> Finance: matched ${rBus.matchedCount || 0}, modified ${rBus.modifiedCount || 0}`);

  console.log("\n== Normalizing ALL Articles to allowed categories (else General) ==");

  // Normalize every article's slug (handles weird old values)
  const cursor = Article.find({}, { _id: 1, category: 1, categorySlug: 1 }).cursor();

  let changed = 0;
  for await (const a of cursor) {
    const raw = a.categorySlug || a.category || "general";
    const normalized = normalizeLegacySlug(raw);

    const finalSlug = allowedSlugs.has(normalized) ? normalized : "general";
    const finalName = ALLOWED.find((x) => x.slug === finalSlug)?.name || "General";

    // only write if needed
    if (a.categorySlug !== finalSlug || a.category !== finalName) {
      await Article.updateOne(
        { _id: a._id },
        { $set: { categorySlug: finalSlug, category: finalName } }
      );
      changed++;
    }
  }

  console.log(`- Articles normalized/updated: ${changed}`);

  console.log("\n== Deleting categories not in allowed list (newsdb) ==");
  const allCats = await Category.find({}, { slug: 1, name: 1 }).lean();
  const toDelete = allCats.filter((c) => !allowedSlugs.has(String(c.slug)));

  if (toDelete.length) {
    const slugs = toDelete.map((c) => c.slug);
    await Category.deleteMany({ slug: { $in: slugs } });
    console.log(`- Deleted categories: ${toDelete.length}`);
  } else {
    console.log("- Deleted categories: 0");
  }

  const indiaCount = await Article.countDocuments({ categorySlug: "india" });
  console.log("\n== Quick verify ==");
  console.log("India article count (newsdb) =", indiaCount);

  console.log("\n✅ Done (newsdb).");
}

main()
  .catch((e) => {
    console.error("❌ prune-categories-newsdb failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await mongoose.disconnect(); } catch {}
  });
