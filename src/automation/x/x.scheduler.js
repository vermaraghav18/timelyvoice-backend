// src/automation/x/x.scheduler.js
const XSource = require("../../models/XSource");
const XItem   = require("../../models/XItem");
const { fetchTweetsForHandle } = require("./x.service");
const { processNewTweets }     = require("./x.pipeline");

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function start() {
  const interval = Number(process.env.AUTMOTION_INTERVAL_SECONDS || 300);

  async function runCycle() {
    console.log("[X] Auto-cycle started");
    const sources = await XSource.find({ enabled: true });

    // 1) Fetch for each source
    for (const src of sources) {
      try {
        const count = await fetchTweetsForHandle(src.handle, 4);
        console.log(`[X] ${src.handle} → fetched ${count} tweets`);
      } catch (err) {
        console.error(`[X] ${src.handle} fetch error:`, err?.message || err);
      }
      await sleep(120);
    }

    // 2) Process until empty
    try {
      let round = 0, total = 0;
      while (true) {
        const { processed, skipped, errors } = await processNewTweets({ limit: 20 });
        const moved = processed + skipped + errors;
        if (!moved) break;
        total += moved;
        round++;
        console.log(`[X] processed round=${round} → ok:${processed} skip:${skipped} err:${errors}`);
        await sleep(300);
      }
      console.log("[X] Cycle complete");
    } catch (err) {
      console.error("[X] processNewTweets failed:", err?.message || err);
    }
  }

  // run now, then on interval
  runCycle();
  setInterval(runCycle, interval * 1000);
}

module.exports = { start };
