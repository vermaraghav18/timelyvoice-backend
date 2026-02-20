// backend/src/routes/admin.prompt.routes.js
const express = require("express");
const router = express.Router();

const {
  getPrompt,
  savePrompt,
} = require("../controllers/admin.prompt.controller");

router.get("/", getPrompt);
router.put("/", savePrompt);

module.exports = router;
