// backend/src/routes/automation.routes.js
"use strict";

const express = require("express");
const router = express.Router();
const automation = require("../controllers/automation.controller");

// Optional: if you expose an auth middleware from your controller, we use it.
// Otherwise this falls back to a no-op (keeps current behavior open for local dev).
const requireAuth = automation.requireAuth || ((req, _res, next) => next());

// ------ Debug ------
router.get("/_debug/automation-ping", automation.pingAutomation);

// ------ Feeds ------
router.get("/feeds", requireAuth, automation.getFeeds);
router.get("/feeds/:id", requireAuth, automation.getFeedById);
router.post("/feeds", requireAuth, automation.createFeed);
router.patch("/feeds/:id", requireAuth, automation.updateFeed);
router.delete("/feeds/:id", requireAuth, automation.deleteFeed);
router.post("/feeds/:id/fetch", requireAuth, automation.fetchFeed);
router.post("/feeds/fetch-all", requireAuth, automation.fetchAllFeeds);
router.delete("/feeds/_dedupe", requireAuth, automation.dedupeFeeds);

// ------ X Sources (NEW) ------
router.get("/x/sources", requireAuth, automation.listXSources);
router.post("/x/sources", requireAuth, automation.createXSource);
router.patch("/x/sources/:id", requireAuth, automation.updateXSource);
router.delete("/x/sources/:id", requireAuth, automation.deleteXSource);

// ------ Items ------
router.get("/items", requireAuth, automation.listItems);
router.post("/items/:id/extract", requireAuth, automation.extractItem);
router.post("/items/:id/generate", requireAuth, automation.generateItem);
router.post("/items/:id/mark-ready", requireAuth, automation.markReady);
router.post("/items/:id/draft", requireAuth, automation.createDraft);
router.post("/items/:id/run", requireAuth, automation.runSingle);

// ------ Batch process ------
router.post("/process", requireAuth, automation.processBatch);

module.exports = router;
