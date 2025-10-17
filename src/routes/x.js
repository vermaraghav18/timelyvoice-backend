// backend/src/routes/x.js
"use strict";

const express = require("express");
const router = express.Router();

const x = require("../controllers/x.controller"); // <- correct import

// ---------- Sources ----------
router.get("/sources", x.listXSources);
router.post("/sources", x.createXSource);
router.patch("/sources/:id", x.updateXSource);
router.delete("/sources/:id", x.deleteXSource);
router.post("/sources/:id/fetch", x.fetchXSource); // <- function ref, NO ()

// ---------- Items ----------
router.get("/items", x.listXItems);
router.post("/items/:id/extract", x.extractXItem);
router.post("/items/:id/generate", x.generateXItem);
router.post("/items/:id/ready", x.markReadyXItem);
router.post("/items/:id/draft", x.createDraftFromXItem);

module.exports = router;
