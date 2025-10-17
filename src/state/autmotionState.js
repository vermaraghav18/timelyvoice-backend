// backend/src/state/autmotionState.js
let running = false;
let inFlight = false;
let timer = null;
let intervalSec = parseInt(process.env.AUTMOTION_INTERVAL_SECONDS || "300", 10);
let lastRun = null;
let nextRun = null;

function getStatus() {
  return { running, inFlight, intervalSec, lastRun, nextRun };
}

function setIntervalSec(sec) {
  intervalSec = Math.max(30, Number(sec) || 300);
  return intervalSec;
}

function setTimer(t) { timer = t; }
function getTimer() { return timer; }

function setRunning(v) { running = !!v; }
function setInFlight(v) { inFlight = !!v; }
function setLastRun(d) { lastRun = d || new Date(); }
function setNextRun(d) { nextRun = d || null; }

module.exports = {
  getStatus, setIntervalSec,
  setTimer, getTimer,
  setRunning, setInFlight, setLastRun, setNextRun
};
