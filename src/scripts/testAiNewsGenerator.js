// backend/src/scripts/testAiNewsGenerator.js
"use strict";

const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "../../.env"),
});

const { generateNewsBatch } = require("../services/aiNewsGenerator");

(async () => {
  try {
    console.log("🔄 Calling generateNewsBatch(count=3)...");
    const { raw, normalized } = await generateNewsBatch({ count: 3 });

    console.log("\n=== RAW JSON KEYS FROM MODEL ===");
    console.log(Object.keys(raw || {}));

    console.log("\n=== NORMALIZED ARTICLES (summary only) ===");
    console.dir(
      normalized.map((a, i) => ({
        i,
        title: a.title,
        category: a.category,
        slug: a.slug,
        publishAt: a.publishAt,
      })),
      { depth: null }
    );

    console.log(`\n✅ Done. Generated ${normalized.length} normalized articles.`);
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Error in testAiNewsGenerator:", err.message || err);
    console.error(err);
    process.exit(1);
  }
})();
