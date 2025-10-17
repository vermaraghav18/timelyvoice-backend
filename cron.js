// backend/cron.js
const cron = require('node-cron');
const { rollupDaily } = require('./jobs/rollupDaily');

const CRON_TZ = process.env.CRON_TZ || 'UTC';
// true -> run every minute for testing; false -> use DAILY_SCHEDULE
const CRON_DEBUG_EVERY_MINUTE = String(process.env.CRON_DEBUG_EVERY_MINUTE || 'false') === 'true';
// real daily schedule (00:05 UTC by default)
const DAILY_SCHEDULE = process.env.CRON_DAILY || '5 0 * * *';

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

async function run(label) {
  try {
    // rollupDaily() without a date = “today (UTC)”
    const res = await rollupDaily();
    console.log(`[cron:${label}] ok date=%s pv=%s`, res.date, res.totals?.page_view ?? '—');
  } catch (e) {
    console.error(`[cron:${label}] failed`, e);
  }
}

// 1) Ensure today exists on boot (idempotent)
run('boot');

// 2) Real daily run (00:05 UTC by default)
cron.schedule(DAILY_SCHEDULE, () => run('daily'), { timezone: CRON_TZ });

// 3) Optional fast loop for dev
if (CRON_DEBUG_EVERY_MINUTE) {
  cron.schedule('* * * * *', () => run('debug-1m'), { timezone: CRON_TZ });
  console.warn('[cron] DEBUG_EVERY_MINUTE=true — running every minute for testing');
}

// === Autmotion: start scheduler on boot (respects AUTMOTION_ENABLED) ===
try {
  const { startAutmotion } = require("./src/jobs/autmotion");
  if (String(process.env.AUTMOTION_ENABLED || "true") === "true") {
    const sec = parseInt(process.env.AUTMOTION_INTERVAL_SECONDS || "300", 10);
    startAutmotion(sec);
  } else {
    console.log("[autmotion] booted in paused mode (AUTMOTION_ENABLED=false)");
  }
} catch (e) {
  console.warn("[autmotion] not started:", e?.message || e);
}
