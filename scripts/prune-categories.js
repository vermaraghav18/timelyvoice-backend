/**
 * One-time maintenance script
 * - Keeps ONLY the allowed categories (9)
 * - Renames Business -> Finance and Politics -> India (both Category docs + Articles)
 * - Moves any article with a now-removed category into General
 *
 * Run:
 *   cd backend
 *   node scripts/prune-categories.js
 */

require("dotenv").config();
const mongoose = require("mongoose");

const Category = require("../src/models/Category");
const Article = require("../src/models/Article");

// Keep ONLY these 9 categories:
const KEEP = [
  { name: "India", slug: "india", type: "topic" },
  { name: "World", slug: "world", type: "topic" },
  { name: "Health", slug: "health", type: "topic" },
  { name: "Finance", slug: "finance", type: "topic" },
  { name: "History", slug: "history", type: "topic" },
  { name: "New Delhi", slug: "new-delhi", type: "city" },
  { name: "Punjab", slug: "punjab", type: "state" },
  { name: "Entertainment", slug: "entertainment", type: "topic" },
  { name: "General", slug: "general", type: "topic" },
];

const ALLOWED_SLUGS = KEEP.map((c) => c.slug);
const ALLOWED_NAMES_LC = new Set(KEEP.map((c) => c.name.toLowerCase()));

function ci(s) {
  return new RegExp(
    `^${String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    "i"
  );
}

async function upsertCategory({ name, slug, type }) {
  const existing = await Category.findOne({ $or: [{ slug }, { name: ci(name) }] });
  if (!existing) {
    await Category.create({ name, slug, type });
    return { action: "created", name, slug };
  }

  const update = {};
  if (existing.name !== name) update.name = name;
  if (existing.slug !== slug) update.slug = slug;
  if (type && existing.type !== type) update.type = type;

  if (Object.keys(update).length) {
    await Category.updateOne({ _id: existing._id }, { $set: update });
    return { action: "updated", name, slug };
  }
  return { action: "kept", name, slug };
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("Missing MONGO_URI (or MONGODB_URI) in backend/.env or environment.");

  await mongoose.connect(uri);
  console.log("✅ Connected to MongoDB");

  // 1) Ensure the 9 categories exist
  console.log("\n== Ensuring allowed categories exist ==");
  for (const c of KEEP) {
    const r = await upsertCategory(c);
    console.log(`- ${r.action}: ${c.name} (${c.slug})`);
  }

  // 2) Rename Articles: Business -> Finance
  console.log("\n== Updating Articles: Business -> Finance, Politics -> India ==");

  const r1 = await Article.updateMany(
    { $or: [{ category: ci("Business") }, { categorySlug: ci("business") }] },
    { $set: { category: "Finance", categorySlug: "finance" } }
  );

  // 3) Rename Articles: Politics -> India
  const r2 = await Article.updateMany(
    { $or: [{ category: ci("Politics") }, { categorySlug: ci("politics") }] },
    { $set: { category: "India", categorySlug: "india" } }
  );

  console.log(`- Updated to Finance: ${r1.modifiedCount || 0}`);
  console.log(`- Updated to India:   ${r2.modifiedCount || 0}`);

  // 4) Any article whose categorySlug is not allowed -> General
  console.log("\n== Normalizing remaining Articles to allowed categories (else General) ==");

  const r3 = await Article.updateMany(
    { categorySlug: { $exists: true, $ne: null, $nin: ALLOWED_SLUGS } },
    { $set: { category: "General", categorySlug: "general" } }
  );

  // 5) Delete categories NOT in allowed list
  console.log("\n== Deleting categories not in allowed list ==");
  const del = await Category.deleteMany({ slug: { $nin: ALLOWED_SLUGS } });
  console.log(`- Deleted categories: ${del.deletedCount || 0}`);

  console.log("\n✅ Done. Your admin dropdown will now show only the 9 categories.");
}

main()
  .catch((e) => {
    console.error("❌ prune-categories failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await mongoose.disconnect(); } catch {}
  });
