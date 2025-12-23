require("dotenv").config();
const mongoose = require("mongoose");
const Category = require("../src/models/Category");

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.log("NO_MONGO_URI_FOUND");
    process.exit(1);
  }

  await mongoose.connect(uri, { dbName: "newsdb" });
  console.log("CONNECTED_DB =", mongoose.connection.name);

  const c = await Category.findOne({ slug: "india" }).lean();
  console.log("INDIA_IN_NEWSDB =", !!c);
  if (c) console.log("INDIA_DOC_NEWSDB =", c);

  await mongoose.disconnect();
})();
