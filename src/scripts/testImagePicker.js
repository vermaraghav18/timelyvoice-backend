// src/scripts/testImagePicker.js

require("dotenv/config"); // load .env for local runs
const { chooseHeroImage } = require("../services/imagePicker");

(async () => {
  try {
    const meta = {
      title: "PM Modi addresses rally in Bihar",   // change this to any test title
      summary:
        "Prime Minister Narendra Modi held a massive public rally ahead of the upcoming elections.",
      category: "Politics",
      tags: ["Modi", "Bihar", "Elections"],
      slug: "pm-modi-addresses-rally-in-bihar",
    };

    console.log("Running chooseHeroImage with meta:", meta);

    const result = await chooseHeroImage(meta);

    console.log("\n=== chooseHeroImage RESULT ===");
    console.log(JSON.stringify(result, null, 2));
    console.log("================================\n");

    process.exit(0);
  } catch (err) {
    console.error("testImagePicker error:", err);
    process.exit(1);
  }
})();
