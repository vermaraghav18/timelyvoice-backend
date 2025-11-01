# upload-fallback.ps1
$env:CLOUDINARY_CLOUD_NAME = "your_cloud_name"
$env:CLOUDINARY_API_KEY    = "your_api_key"
$env:CLOUDINARY_API_SECRET = "your_api_secret"

# local fallback file (put a jpg/png here)
$localImagePath = "C:\Users\PC\Downloads\fallback.jpg"

$script = @"
const cloudinary = require('cloudinary').v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});
cloudinary.uploader.upload('$localImagePath', {
  folder: 'news-images/defaults',
  public_id: 'fallback-hero',
  overwrite: true,
  resource_type: 'image'
}).then(r => {
  console.log('✅ Uploaded successfully:');
  console.log('Public ID:', r.public_id);
  console.log('URL:', r.secure_url);
}).catch(e => {
  console.error('❌ Upload failed:', e.message);
});
"@

node -e $script
