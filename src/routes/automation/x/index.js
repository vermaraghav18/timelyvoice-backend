"use strict";
const express = require("express");
const router = express.Router();

// ✅ Correct path (3 levels up from /x)
const automationCtrl = require("../../../controllers/automation.controller");
const x = require("../../../controllers/x.controller");

// ---------- Forwarded automation items ----------
router.get("/items", automationCtrl.listItems);

// ---------- X Sources ----------
router.get("/sources", x.listXSources);
router.post("/sources", x.createXSource);
router.patch("/sources/:id", x.updateXSource);
router.delete("/sources/:id", x.deleteXSource);
router.post("/sources/:id/fetch", x.fetchXSource);

// ---------- X Items ----------
router.post("/items/:id/extract", x.extractXItem);
router.post("/items/:id/generate", x.generateXItem);
router.post("/items/:id/ready", x.markReadyXItem);
router.post("/items/:id/draft", x.createDraftFromXItem);

module.exports = router;
