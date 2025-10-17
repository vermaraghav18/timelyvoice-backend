// backend/src/jobs/autmotion.js
const {
  getStatus, setIntervalSec, setTimer, getTimer,
  setRunning, setInFlight, setLastRun, setNextRun
} = require("../state/autmotionState");

// If you already have these helpers in automation.controller.js, great.
// If not, the tick() below will simply do nothing but still update status.
let helpers;
try {
  helpers = require("../controllers/automation.controller");
} catch (_) {
  helpers = {};
}

async function tick() {
  const st = getStatus();
  if (!st.running) return;

  if (st.inFlight) return; // prevent overlap
  setInFlight(true);
  setLastRun(new Date());

  try {
    // 1) Fetch feeds due (optional if your controller has it)
    if (typeof helpers.fetchAllDueFeeds === "function") {
      await helpers.fetchAllDueFeeds();
    }

    // 2) Process pending items (optional if your controller has it)
    if (typeof helpers.processPendingItems === "function") {
      await helpers.processPendingItems();
    }

    // If you don’t have the above yet, this still acts as a heartbeat.
    // We keep it harmless and idempotent.
  } catch (e) {
    console.warn("[autmotion] tick error:", e?.message || e);
  } finally {
    setInFlight(false);
    const sec = getStatus().intervalSec;
    setNextRun(new Date(Date.now() + sec * 1000));
  }
}

function startAutmotion(secOverride) {
  if (getTimer()) stopAutmotion();

  if (typeof secOverride !== "undefined") setIntervalSec(secOverride);
  const sec = getStatus().intervalSec;

  setRunning(true);
  setNextRun(new Date(Date.now() + sec * 1000));

  const t = setInterval(tick, sec * 1000);
  setTimer(t);
  console.log(`[autmotion] started, every ${sec}s`);
}

function stopAutmotion() {
  const t = getTimer();
  if (t) clearInterval(t);
  setTimer(null);
  setRunning(false);
  setNextRun(null);
  console.log("[autmotion] stopped");
}

async function runOnceNow() {
  // Run a single tick immediately (even if stopped)
  const wasRunning = getStatus().running;
  setRunning(true);
  try {
    await tick();
  } finally {
    setRunning(wasRunning);
  }
}

module.exports = { startAutmotion, stopAutmotion, runOnceNow, getStatus };
