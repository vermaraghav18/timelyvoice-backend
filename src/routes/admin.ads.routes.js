const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/ads.controller");

// Base path (mounted at /api/admin/ads)
router.get("/", ctrl.list);
router.get("/:id", ctrl.read);
router.post("/", ctrl.create);
router.patch("/:id", ctrl.update);
router.delete("/:id", ctrl.remove);

module.exports = router;
