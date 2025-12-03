const { listFilesInFolder } = require("../services/googleDrive");

async function main() {
  const folderId = process.env.GOOGLE_DRIVE_NEWS_FOLDER_ID;
  if (!folderId) {
    console.error("❌ GOOGLE_DRIVE_NEWS_FOLDER_ID not set in .env");
    process.exit(1);
  }

  const files = await listFilesInFolder(folderId);
  console.log("Found files:");
  files.forEach(f => console.log(`- ${f.id}  ${f.name}`));
}

main().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
