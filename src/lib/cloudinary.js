// backend/src/lib/cloudinary.js
const { v2: cloudinary } = require('cloudinary');

function configure() {
  const cfg = cloudinary.config(); // auto-reads CLOUDINARY_URL if present
  if (!cfg.cloud_name && process.env.CLOUDINARY_CLOUD_NAME) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  } else {
    cloudinary.config({ secure: true });
  }
  const c = cloudinary.config();
  if (!c.cloud_name) {
    throw new Error('[Cloudinary] cloud_name missing. Set CLOUDINARY_URL or 3 creds.');
  }
  console.log('[Cloudinary] configured for cloud:', c.cloud_name);
}
configure();

module.exports = cloudinary;
