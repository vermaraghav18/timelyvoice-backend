// upload-fallback.js
const cloudinary = require('cloudinary').v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});
const localImagePath = 'C:\\Users\\PC\\Downloads\\fallback-hero.jpg'; // your file
(async () => {
  const r = await cloudinary.uploader.upload(localImagePath, {
    folder: 'news-images/defaults',
    public_id: 'fallback-hero',        // no extension in public_id
    overwrite: true,
    resource_type: 'image'
  });
  console.log('Public ID:', r.public_id);
  console.log('URL      :', r.secure_url);
})();
