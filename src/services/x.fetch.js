// backend/src/services/x.fetch.js
// Token-less Twitter fetch via Nitter with:
//  - Mirror rotation (env + builtin)
//  - Realistic headers & UA rotation
//  - RSS validation (must have <item>), else HTML fallback
//  - Proxy fallbacks: optional CF Worker, plus r.jina.ai reader
//
// Env knobs (optional):
//   NITTER_BASES=comma,separated,mirrors
//   NITTER_BASE=single-mirror
//   CF_WORKER_BASE=https://your-worker.workers.dev   (see note below)
//   HTTPS_PROXY=...                                  (if you run through a local proxy)

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const { XMLParser } = require('fast-xml-parser');
const cheerio = require('cheerio');

// ---- UA rotation ----------------------------------------------------
const USER_AGENTS = [
  // Desktop Chrome
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36',
  // Desktop Firefox
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  // Android Chrome
  'Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Mobile Safari/537.36',
  // iPhone Safari
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
];
function pickUA(seed = Math.random()) {
  const i = Math.floor(seed * USER_AGENTS.length);
  return USER_AGENTS[i] || USER_AGENTS[0];
}

// ---- Mirrors --------------------------------------------------------
const BUILTIN_MIRRORS = [
  'https://nitter.net',
  'https://nitter.poast.org',
  'https://nitter.fdn.fr',
  'https://nitter.privacydev.net',
  'https://nitter.moomoo.me',
  'https://nitter.kavin.rocks',
  'https://nitter.catsarch.com',
  'https://n.openstick.io',
  'https://nitter.slipfox.xyz',
  'https://nitter.tux.pizza',
  'https://nitter.cz',
];

function buildMirrorList() {
  const fromList = (process.env.NITTER_BASES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const single = (process.env.NITTER_BASE || '').trim();

  const mirrors = [...fromList, single, ...BUILTIN_MIRRORS]
    .filter(Boolean)
    .map(u => u.replace(/\/+$/, ''));

  const seen = new Set();
  const out = [];
  for (const m of mirrors) if (!seen.has(m)) { seen.add(m); out.push(m); }
  return out.slice(0, 14);
}

// Build URL variants for a given base/path:
//  1) direct base
//  2) optional Cloudflare Worker (CF_WORKER_BASE)
//  3) r.jina.ai read-through (forces GET from a crawler-friendly domain)
function buildUrlVariants(base, path) {
  const variants = [];
  const direct = `${base}${path}`;
  variants.push({ label: base, url: direct });

  const cf = (process.env.CF_WORKER_BASE || '').trim().replace(/\/+$/, '');
  if (cf) {
    variants.push({ label: `${cf} (cf-worker)`, url: `${cf}${path}` });
  }

  // r.jina.ai: we must pass the full original URL *including protocol* after the host
  // e.g., https://r.jina.ai/http://nitter.net/<handle>/rss
  // We intentionally drop 'https://' to 'http://' for the inner URL — r.jina.ai accepts both,
  // but http is more permissive for some blocks.
  const inner = direct.replace(/^https:\/\//, 'http://');
  variants.push({ label: 'https://r.jina.ai (reader)', url: `https://r.jina.ai/${inner}` });

  return variants;
}

// ---- HTTP helpers ---------------------------------------------------
async function tryFetch(url, {
  timeoutMs = 9000,
  accept = 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
} = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': pickUA(),
      'Accept': accept,
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    },
    timeout: timeoutMs,
    redirect: 'follow',
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return { text, contentType: (res.headers.get('content-type') || '').toLowerCase() };
}

function looksLikeRealRSS(xml) {
  const t = (xml || '').trim();
  if (t.length < 2000) return false;                 // too small → likely challenge/placeholder
  if (!/<rss\b/i.test(t)) return false;
  if (!/<channel\b/i.test(t)) return false;
  if (!/<item\b/i.test(t)) return false;
  return true;
}

// ---- Parsing --------------------------------------------------------
function parseNitterRSS(xml, mirrorUsed, { limit = 50 } = {}) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: true,
    trimValues: true,
  });
  const rss = parser.parse(xml);
  const items = [].concat(rss?.rss?.channel?.item || []).slice(0, limit);

  const out = [];
  for (const it of items) {
    const title = it?.title || '';
    const link = it?.link || '';
    const pubDate = it?.pubDate || it?.pubdate || null;
    const desc = it?.description || it?.['content:encoded'] || '';

    const m = link.match(/status\/(\d+)/);
    const xId = m ? m[1] : null;

    const urls = [];
    const urlRx = /href="(https?:\/\/[^"]+)"/g;
    let u; while ((u = urlRx.exec(desc))) urls.push(u[1]);

    const media = [];
    const imgRx = /<img[^>]+src="([^"]+)"/g;
    let im; while ((im = imgRx.exec(desc))) {
      let src = im[1];
      if (src?.startsWith('/')) src = `${mirrorUsed}${src}`;
      media.push({ type: 'photo', url: src });
    }

    if (xId) {
      out.push({
        xId,
        handle: null, // set later
        text: title,
        tweetedAt: pubDate ? new Date(pubDate).toISOString() : null,
        urls: Array.from(new Set(urls)),
        media,
      });
    }
  }
  return out;
}

function parseNitterHTML(html, mirrorUsed, handle, { limit = 50 } = {}) {
  const $ = cheerio.load(html);
  const found = [];

  $('.timeline-item').each((_, el) => {
    const href = $(el).find('.tweet-link').attr('href') || '';
    const id = href.split('/status/')[1]?.split('?')[0];
    const text = $(el).find('.tweet-content').text().trim();
    const timeStr = $(el).find('time').attr('datetime');
    const tweetedAt = timeStr ? new Date(timeStr).toISOString() : null;

    const media = [];
    $(el).find('.attachments img').each((__, img) => {
      let src = $(img).attr('src') || '';
      if (src && src.startsWith('/')) src = mirrorUsed + src;
      if (src) media.push({ type: 'photo', url: src });
    });

    if (id) {
      found.push({
        xId: id,
        handle,
        text,
        tweetedAt,
        urls: [],
        media,
      });
    }
  });

  return found.slice(0, limit);
}

// ---- Fetch attempts -------------------------------------------------
async function fetchFromFirstWorking(builders, {
  timeoutMs = 9000,
  retriesPerVariant = 2,
  accept,
  validator,
} = {}) {
  const errors = [];
  for (const make of builders) {
    const v = make();
    let attempt = 0;
    while (attempt <= retriesPerVariant) {
      try {
        const { text, contentType } = await tryFetch(v.url, { timeoutMs, accept });
        if (validator && !validator({ text, contentType })) {
          throw new Error(`Invalid content from ${v.label} (${contentType || 'unknown'})`);
        }
        return { body: text, label: v.label, contentType };
      } catch (e) {
        errors.push(`[${v.label}] ${e.message || e}`);
        attempt += 1;
        if (attempt > retriesPerVariant) break;
        await new Promise(r => setTimeout(r, 300 + attempt * 150));
      }
    }
  }
  const err = new Error(`All Nitter attempts failed. Tried: ${builders.map(b => b().label).join(', ')}`);
  err.details = errors.slice(0, 12);
  err.status = 502;
  err.expose = true;
  throw err;
}

async function fetchFromNitterRSS(handle, { limit = 50 } = {}) {
  const mirrors = buildMirrorList();
  if (!mirrors.length) {
    const e = new Error('No Nitter mirrors configured');
    e.status = 500; e.expose = true;
    throw e;
  }

  // For each mirror, we try direct + CF Worker + r.jina.ai variants
  const builders = mirrors.flatMap(base => buildUrlVariants(base, `/${encodeURIComponent(handle)}/rss`))
                          .map(v => () => v);

  const { body: xml, label: mirrorUsed } = await fetchFromFirstWorking(builders, {
    timeoutMs: 10000,
    retriesPerVariant: 2,
    accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
    validator: ({ text }) => looksLikeRealRSS(text),
  });

  const items = parseNitterRSS(xml, mirrorUsed, { limit });
  for (const it of items) it.handle = handle;
  return { items, mirrorUsed, xmlLen: xml.length };
}

async function fetchFromNitterHTML(handle, { limit = 50 } = {}) {
  const mirrors = buildMirrorList();
  const builders = mirrors.flatMap(base => buildUrlVariants(base, `/${encodeURIComponent(handle)}`))
                          .map(v => () => v);

  const { body: html, label: mirrorUsed } = await fetchFromFirstWorking(builders, {
    timeoutMs: 10000,
    retriesPerVariant: 2,
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    validator: ({ text }) => /timeline-item/.test(text),
  });

  const items = parseNitterHTML(html, mirrorUsed, handle, { limit });
  return { items, mirrorUsed, htmlLen: html.length };
}

// Try RSS first, then HTML
async function fetchFromNitterAny(handle, { limit = 50 } = {}) {
  const rssErrors = [];
  try {
    const { items, mirrorUsed, xmlLen } = await fetchFromNitterRSS(handle, { limit });
    if (items && items.length) return { items, mirror: mirrorUsed, via: 'rss', size: xmlLen };
    rssErrors.push(`RSS returned 0 items from ${mirrorUsed} (xmlLen=${xmlLen})`);
  } catch (e) {
    rssErrors.push(e.message || String(e));
  }

  try {
    const { items, mirrorUsed, htmlLen } = await fetchFromNitterHTML(handle, { limit });
    if (items && items.length) return { items, mirror: mirrorUsed, via: 'html', size: htmlLen };
    throw new Error(`HTML returned 0 items from ${mirrorUsed} (htmlLen=${htmlLen})`);
  } catch (e) {
    const err = new Error(`All Nitter attempts failed for @${handle}`);
    err.details = { rssErrors, htmlError: e.message || String(e) };
    err.expose = true; err.status = 502;
    throw err;
  }
}

// ---- Public API -----------------------------------------------------
async function fetchUserTimeline({ handle, limit = 50 }) {
  const h = String(handle || '').replace(/^@/, '');
  if (!h) { const e = new Error('Invalid handle'); e.status = 400; e.expose = true; throw e; }
  const { items } = await fetchFromNitterAny(h, { limit });
  return items;
}

/* ----------------- DEBUG helper (unchanged API) --------------------- */
async function debugFetchTimeline({ handle, limit = 10 } = {}) {
  const h = String(handle || '').replace(/^@/, '');
  if (!h) return { ok: false, errors: ['handle required'] };

  const mirrors = buildMirrorList();

  // 1) RSS pass
  const buildersRSS = mirrors.flatMap(base => buildUrlVariants(base, `/${encodeURIComponent(h)}/rss`))
                             .map(v => () => v);
  const rssDiag = { tried: [], errors: [] };
  for (const make of buildersRSS) {
    const { label, url } = make();
    rssDiag.tried.push(label);
    try {
      const { text } = await tryFetch(url, { timeoutMs: 10000 });
      if (!looksLikeRealRSS(text)) {
        rssDiag.errors.push(`[${label}] not real RSS or no <item> (len=${text.length})`);
        continue;
      }
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        parseTagValue: true,
        trimValues: true,
      });
      const rss = parser.parse(text);
      const items = [].concat(rss?.rss?.channel?.item || []).slice(0, limit);
      const sample = items.slice(0, 3).map(it => ({
        title: (it?.title || '').toString().slice(0, 140),
        link: it?.link || null,
        pubDate: it?.pubDate || it?.pubdate || null
      }));
      return { ok: true, stage: 'rss', mirrorUsed: label, size: text.length, itemCount: items.length, sample };
    } catch (e) {
      rssDiag.errors.push(`[${label}] ${e?.message || e}`);
    }
  }

  // 2) HTML pass
  const buildersHTML = mirrors.flatMap(base => buildUrlVariants(base, `/${encodeURIComponent(h)}`))
                              .map(v => () => v);
  const htmlDiag = { tried: [], errors: [] };
  for (const make of buildersHTML) {
    const { label, url } = make();
    htmlDiag.tried.push(label);
    try {
      const { text } = await tryFetch(url, {
        timeoutMs: 10000,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
      });
      if (!/timeline-item/.test(text)) {
        htmlDiag.errors.push(`[${label}] HTML missing timeline-item (len=${text.length})`);
        continue;
      }
      const items = parseNitterHTML(text, label, h, { limit });
      const sample = items.slice(0, 3).map(it => ({
        title: (it?.text || '').toString().slice(0, 140),
        link: `https://x.com/${h}/status/${it.xId}`,
        pubDate: it.tweetedAt
      }));
      return { ok: true, stage: 'html', mirrorUsed: label, size: text.length, itemCount: items.length, sample };
    } catch (e) {
      htmlDiag.errors.push(`[${label}] ${e?.message || e}`);
    }
  }

  return { ok: false, stage: 'none', errors: { rssDiag, htmlDiag } };
}

module.exports = {
  fetchUserTimeline,
  debugFetchTimeline,
};
