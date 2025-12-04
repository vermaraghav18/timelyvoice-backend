const express = require("express");
const router = express.Router();

const { chooseHeroImage } = require("../services/imagePicker");

router.post("/image-picker", async (req, res) => {
  try {
    const { meta } = req.body;
    const result = await chooseHeroImage(meta);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

module.exports = router;
