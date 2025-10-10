const router = require('express').Router();
const multer  = require('multer');
const sharp   = require('sharp');
const path    = require('path');
const { nanoid } = require('nanoid');
const Media = require('../models/Media');
const { auth, permit } = require('../middleware/auth');

const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(png|jpe?g|webp)$/.test(file.mimetype);
    cb(ok ? null : new Error('Unsupported mime'), ok);
  }
});

router.post('/upload', auth, permit(['author','editor','admin']), upload.single('file'), async (req,res) => {
  const id = nanoid();
  const ext = req.file.mimetype.includes('png') ? 'png' : req.file.mimetype.includes('webp') ? 'webp' : 'jpg';
  const out = path.join(process.env.UPLOAD_DIR || 'uploads', `${id}.${ext}`);
  const image = sharp(req.file.buffer);
  const meta = await image.metadata();
  await image.toFile(out);

  const doc = await Media.create({
    url: `/${out}`,
    mime: req.file.mimetype,
    size: req.file.size,
    width: meta.width, height: meta.height,
    createdBy: req.user?._id
  });
  res.status(201).json(doc);
});

router.get('/', auth, permit(['author','editor','admin']), async (req,res) => {
  const items = await Media.find().sort({ createdAt: -1 }).limit(200);
  res.json(items);
});

router.delete('/:id', auth, permit(['editor','admin']), async (req,res) => {
  await Media.deleteOne({ _id: req.params.id });
  res.sendStatus(204);
});

module.exports = router;
