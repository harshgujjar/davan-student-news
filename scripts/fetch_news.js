/**
 * Davan Student Widget — Page 6 "News & Rates" data fetcher.
 *
 * Runs as a scheduled GITHUB ACTIONS workflow (see
 * .github/workflows/fetch-news.yml in this repo), NOT Google Cloud
 * Functions — that path was dropped because it requires the Blaze
 * billing plan on Firebase, which was explicitly declined (2026-08-30).
 * GitHub Actions needs no billing account and no Google Cloud project at
 * all; it only needs a Firebase SERVICE ACCOUNT KEY, stored as an
 * encrypted GitHub Secret (see AUTH section below), to get write access
 * to db3 (davan-student-news RTDB). Same fetch logic as the original
 * Cloud Function draft — only the trigger mechanism and the Firebase
 * auth method changed.
 *
 * Fetches India/World RSS headlines + USD/INR rate + weather + a daily
 * quote ONCE per run, server-side (GitHub's runners, not any student's
 * phone), and writes clean JSON to db3. Every student widget then does a
 * plain Firebase read — NO device ever hits a publisher's RSS/HTML page
 * directly. See SESSION_MEMORY.md w67 handoff and the 2026-08-30 design
 * conversation for why (300 devices hitting the same RSS URLs directly
 * is fragile + looks like abuse to the publisher's CDN).
 *
 * Sources (deliberately picked for machine-readable JSON/XML, not scraped
 * HTML — see 2026-08-30 conversation re: MCX/GoodReturns scraping being
 * ruled out):
 *   - India headlines : The Hindu National RSS (XML)
 *   - World headlines : BBC World RSS (XML)
 *   - USD/INR rate    : Frankfurter API (JSON, free, no key, no quota —
 *                        NOTE: this replaces an earlier "RBI RSS" plan,
 *                        which was factually wrong: RBI stopped computing
 *                        the reference rate in 2018 (FBIL does it now),
 *                        and neither publishes a public rate feed)
 *   - Weather         : Open-Meteo (JSON, free, no key) — Davangere coords
 *   - Daily quote      : ZenQuotes (JSON, free, no key)
 *
 * Every fetch below is wrapped so ONE source failing (bad XML, feed down,
 * timeout) never blocks the others — partial data still gets written
 * rather than the whole run failing. This mirrors the same
 * "safe-failure" principle already built into StudentNewsConfig.kt /
 * renderPageNews() on the widget side.
 *
 * Admin override + lock (student_portal.html v9.01, Student Widget
 * Control tab): before doing any fetching, runFetchCycle() checks
 * widgetConfig/newsOverride for `locked: true`. If locked, this run is
 * skipped entirely — the admin's manually-entered values in
 * widgetConfig/news are left exactly as the portal wrote them. Unlocking
 * (clearing the override, or saving with Lock unchecked) resumes normal
 * auto-fetch on the next scheduled run.
 */

const fetch = require('node-fetch');
const xml2js = require('xml2js');
const admin = require('firebase-admin');

// ── db3 config — davan-student-news (same project StudentNewsConfig.kt
//    points at). Uses a service account for admin write access, NOT the
//    public web apiKey the widget uses for reads.
const DB3_DATABASE_URL = 'https://davan-student-news-default-rtdb.asia-southeast1.firebasedatabase.app';

let appInitialized = false;
function ensureFirebaseApp() {
  if (appInitialized) return;
  // GITHUB ACTIONS AUTH: unlike the original Cloud Functions draft
  // (applicationDefault(), which only works INSIDE Google Cloud's own
  // infrastructure), a GitHub Actions runner is a generic machine with no
  // built-in Google identity. It authenticates using a real service
  // account KEY FILE instead, whose JSON contents are stored as the
  // GitHub Secret FIREBASE_SERVICE_ACCOUNT_KEY (see workflow YAML +
  // SETUP NOTES at the bottom of this file for exactly how to create and
  // add that secret). The key is read from an env var at runtime — it is
  // NEVER written to disk or committed to the repo, even though this
  // repo is public.
  const keyJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT_KEY env var is not set. This must be provided ' +
      'as a GitHub Actions secret — see SETUP NOTES at the bottom of this file.'
    );
  }
  const serviceAccount = JSON.parse(keyJson);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: DB3_DATABASE_URL,
  });
  appInitialized = true;
}

const SOURCES = {
  indiaRss: 'https://www.thehindu.com/news/national/?service=rss',
  worldRss: 'https://feeds.bbci.co.uk/news/world/rss.xml',
  rateApi: 'https://api.frankfurter.dev/v2/rate/USD/INR',
  // Davangere, Karnataka coordinates (matches Harsha's meter.html location context)
  weatherApi: 'https://api.open-meteo.com/v1/forecast?latitude=14.4644&longitude=75.9218&current=temperature_2m,weather_code&timezone=Asia%2FKolkata',
  quoteApi: 'https://zenquotes.io/api/today',
  // Free, no-key spot price API (XAU/XAG in USD). No FX call needed —
  // this run already fetches USD/INR via fetchUsdInrRate() above, so
  // fetchGoldSilverRates() reuses that same rate rather than hitting a
  // second FX endpoint.
  goldApi: 'https://api.gold-api.com/price/XAU',
  silverApi: 'https://api.gold-api.com/price/XAG',
};

const FETCH_TIMEOUT_MS = 10000;

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// Parses a standard RSS 2.0 <channel><item><title> feed into a plain
// string array of headline titles, newest first, capped at `max`. Any
// single malformed <item> is skipped rather than failing the whole feed —
// publishers occasionally emit a malformed entry without the whole feed
// being broken.
async function fetchRssHeadlines(url, max) {
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'DavanStudentWidget-NewsFetcher/1.0' },
  });
  const xml = await res.text();
  const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false, trim: true });

  const items = parsed && parsed.rss && parsed.rss.channel && parsed.rss.channel.item;
  if (!items) return [];
  const itemList = Array.isArray(items) ? items : [items];

  const headlines = [];
  for (const item of itemList) {
    try {
      const title = typeof item.title === 'string' ? item.title : (item.title && item.title._);
      if (title && title.trim()) headlines.push(title.trim());
    } catch (e) {
      // skip malformed single item, keep going
    }
    if (headlines.length >= max) break;
  }
  return headlines;
}

async function fetchIndiaHeadlines() {
  try {
    return await fetchRssHeadlines(SOURCES.indiaRss, 4);
  } catch (e) {
    console.error('fetchIndiaHeadlines FAILED:', e.message);
    return [];
  }
}

async function fetchWorldHeadlines() {
  try {
    return await fetchRssHeadlines(SOURCES.worldRss, 4);
  } catch (e) {
    console.error('fetchWorldHeadlines FAILED:', e.message);
    return [];
  }
}

// Frankfurter returns { amount, base, date, rate }. Rounds to 2 decimals
// for widget display (e.g. "83.12") — full precision isn't meaningful on
// a small home-screen widget face.
async function fetchUsdInrRate() {
  try {
    const res = await fetchWithTimeout(SOURCES.rateApi);
    const data = await res.json();
    if (typeof data.rate !== 'number') throw new Error('missing rate field');
    return data.rate.toFixed(2);
  } catch (e) {
    console.error('fetchUsdInrRate FAILED:', e.message);
    return '';
  }
}

// Open-Meteo weather_code -> short human label. Minimal mapping covering
// the common cases; unmapped codes fall back to a generic "Clear"-style
// default rather than showing a raw numeric code to a student.
const WEATHER_CODE_LABELS = {
  0: 'Clear sky', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  80: 'Rain showers', 81: 'Rain showers', 82: 'Heavy showers',
  95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm',
};

async function fetchWeatherLine() {
  try {
    const res = await fetchWithTimeout(SOURCES.weatherApi);
    const data = await res.json();
    const temp = data && data.current && data.current.temperature_2m;
    const code = data && data.current && data.current.weather_code;
    if (typeof temp !== 'number') throw new Error('missing temperature');
    const label = WEATHER_CODE_LABELS[code] || '';
    return label ? `Davangere ${Math.round(temp)}°C, ${label}` : `Davangere ${Math.round(temp)}°C`;
  } catch (e) {
    console.error('fetchWeatherLine FAILED:', e.message);
    return '';
  }
}

// ZenQuotes /api/today returns [{ q: quote, a: author, ... }]. Free-tier
// rate limit is ~5 req/min per IP — a non-issue here since this function
// calls it once per scheduled run (every 45-60 min), not per-device.
async function fetchQuoteText() {
  try {
    const res = await fetchWithTimeout(SOURCES.quoteApi);
    const data = await res.json();
    const entry = Array.isArray(data) ? data[0] : null;
    if (!entry || !entry.q) throw new Error('missing quote field');
    return entry.a ? `${entry.q} — ${entry.a}` : entry.q;
  } catch (e) {
    console.error('fetchQuoteText FAILED:', e.message);
    return '';
  }
}

// Small delay helper — used to stagger the gold/silver calls below so
// they don't hit api.gold-api.com's rate limit as a simultaneous burst.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Gold/Silver rates via api.gold-api.com (free, no key). Converted to
// INR using usdInrRate (already fetched this same cycle — no extra FX
// call). Math ported from Harsha's own gold-silver-rates.html demo:
// troy-ounce USD spot -> INR -> per-10g. Gold shown as 24K and 22K
// (22K = 24K * 0.916); Silver shown per 10g (NOT per kg like the demo
// page, to match gold's unit on a small widget face — Harsha's explicit
// choice, see W68_CHANGES.md).
// AUTO-FETCH ONLY: unlike India/World/quote/weather, there is no admin
// override path for these 3 fields — Harsha's explicit choice.
// Whole block hides on the widget unless all 3 values are present, so
// on ANY failure here this returns empty strings for all three rather
// than partial data (partial data reads as more confusing than none).
//
// SEQUENTIAL, NOT PARALLEL: this originally fired XAU + XAG at the exact
// same instant via Promise.all, which api.gold-api.com's free tier
// rejected with HTTP 429 (confirmed via GitHub Actions run #47 log,
// 2026-09-06 — "fetchGoldSilverRates FAILED: HTTP 429 for
// .../price/XAG"). Fetching XAU, waiting briefly, then fetching XAG
// avoids the same-instant burst that triggered the rate limit.
async function fetchGoldSilverRates(usdInrRate) {
  const empty = { gold24Rate: '', gold22Rate: '', silverRate: '' };
  try {
    const rate = parseFloat(usdInrRate);
    if (!rate) throw new Error('no usdInrRate available for conversion');

    const goldRes = await fetchWithTimeout(SOURCES.goldApi);
    const goldData = await goldRes.json();
    await sleep(1500);
    const silverRes = await fetchWithTimeout(SOURCES.silverApi);
    const silverData = await silverRes.json();

    const goldUsdOz = goldData && goldData.price;
    const silverUsdOz = silverData && silverData.price;
    if (typeof goldUsdOz !== 'number' || typeof silverUsdOz !== 'number') {
      throw new Error('missing price field in gold-api response');
    }

    const gold24Per10g = (goldUsdOz * rate / 31.1034768) * 10;
    const gold22Per10g = gold24Per10g * 0.916;
    const silverPer10g = (silverUsdOz * rate / 31.1034768) * 10;

    return {
      gold24Rate: gold24Per10g.toFixed(0),
      gold22Rate: gold22Per10g.toFixed(0),
      silverRate: silverPer10g.toFixed(0),
    };
  } catch (e) {
    console.error('fetchGoldSilverRates FAILED:', e.message);
    return empty;
  }
}

async function runFetchCycle() {
  ensureFirebaseApp();

  // Portal-side admin control (student_portal.html v9.01, Student Widget
  // Control tab) writes widgetConfig/newsOverride with a `locked` flag
  // when the admin wants their manually-entered values to stick instead
  // of being replaced by the next auto-fetch. Check that FIRST, before
  // doing any of the 5 network fetches below — if it's locked, there is
  // no point spending those API calls just to discard the result.
  const overrideSnap = await admin.database().ref('widgetConfig/newsOverride').once('value');
  const override = overrideSnap.val();
  if (override && override.locked === true) {
    console.log('runFetchCycle: SKIPPED — widgetConfig/newsOverride is locked, admin values left untouched');
    return { skipped: true, reason: 'locked_override' };
  }

  // usdInrRate is fetched first, on its own, because fetchGoldSilverRates()
  // needs it for the USD->INR conversion — everything else still runs in
  // parallel afterward. All fetch*() functions here are failure-isolated
  // (they catch internally and return a safe empty value), so Promise.all
  // is safe: none of them ever reject.
  const usdInrRate = await fetchUsdInrRate();

  const [indiaHeadlines, worldHeadlines, weatherLine, quoteText, goldSilver] = await Promise.all([
    fetchIndiaHeadlines(),
    fetchWorldHeadlines(),
    fetchWeatherLine(),
    fetchQuoteText(),
    fetchGoldSilverRates(usdInrRate),
  ]);

  const payload = {
    indiaHeadlines,
    worldHeadlines,
    usdInrRate,
    weatherLine,
    quoteText,
    gold24Rate: goldSilver.gold24Rate,
    gold22Rate: goldSilver.gold22Rate,
    silverRate: goldSilver.silverRate,
    fetchedAt: Date.now(),
  };

  await admin.database().ref('widgetConfig/news').set(payload);

  console.log('runFetchCycle: wrote to db3', {
    indiaCount: indiaHeadlines.length,
    worldCount: worldHeadlines.length,
    usdInrRate,
    weatherLine,
    hasQuote: !!quoteText,
    gold24Rate: goldSilver.gold24Rate,
    gold22Rate: goldSilver.gold22Rate,
    silverRate: goldSilver.silverRate,
  });

  return payload;
}

// ── Plain script entry point (GitHub Actions runs this as a normal Node
// script — `node scripts/fetch_news.js` — not an HTTP-triggered
// function). Exits 0 on success, non-zero on failure so a failed run
// shows up clearly as a red X in the GitHub Actions tab rather than
// silently succeeding with bad data.
if (require.main === module) {
  runFetchCycle()
    .then((result) => {
      console.log('fetch_news.js: run complete', result);
      process.exit(0);
    })
    .catch((e) => {
      console.error('fetch_news.js: FATAL:', e);
      process.exit(1);
    });
}

module.exports = { runFetchCycle };

/*
 * ══════════════════ SETUP NOTES (GitHub Actions) ══════════════════
 *
 * 1. NO Blaze plan needed anywhere. db3 (davan-student-news) stays on the
 *    free Spark plan — GitHub's own servers run this script, so nothing
 *    Google-Cloud-billing-related is required. This is the whole reason
 *    this version exists (2026-08-30: Blaze explicitly declined).
 *
 * 2. Create a Firebase service account key (one-time):
 *    - Firebase console → davan-student-news → gear icon → Project
 *      settings → Service accounts tab → "Generate new private key"
 *    - This downloads a .json file. NEVER commit this file to the repo
 *      (public repo — this file must not be a real file that gets
 *      pushed; it becomes a GitHub Secret instead, step 4 below).
 *
 * 3. RTDB rules — db3 currently started in TEST MODE (fully open reads
 *    AND writes for 30 days, then locks to fully closed). Before that
 *    window closes, set explicit rules, e.g.:
 *
 *      {
 *        "rules": {
 *          "widgetConfig": {
 *            "news": {
 *              ".read": true,
 *              ".write": false   // only this script's service-account
 *                                 // credential writes here (admin SDK
 *                                 // bypasses rules) — no client,
 *                                 // including the widget or the portal's
 *                                 // db3Set() for /news directly, should
 *                                 // write this exact path other than via
 *                                 // this script. newsOverride SHOULD stay
 *                                 // writable — that's what the portal's
 *                                 // admin panel writes to.
 *            },
 *            "newsOverride": {
 *              ".read": true,
 *              ".write": true    // portal writes here directly (db3Set
 *                                 // in student_portal.html) — keep this
 *                                 // one open, or add proper auth rules
 *                                 // if/when the portal's own DB2 auth
 *                                 // gets extended to db3 too.
 *            },
 *            "pageEnabled": {
 *              ".read": true,
 *              ".write": true
 *            }
 *          }
 *        }
 *      }
 *
 * 4. Add the service account key as a GitHub Secret:
 *    - In your GitHub repo → Settings → Secrets and variables → Actions
 *    - Click "New repository secret"
 *    - Name:  FIREBASE_SERVICE_ACCOUNT_KEY
 *    - Value: paste the ENTIRE contents of the .json file from step 2
 *    - Save. This is encrypted by GitHub, never visible in logs or to
 *      anyone browsing the public repo — even though the repo itself is
 *      public, this secret is not.
 *
 * 5. Commit this file + package.json to the repo at
 *    scripts/fetch_news.js and scripts/package.json (or adjust the
 *    workflow YAML's paths if placed elsewhere).
 *
 * 6. The workflow file (.github/workflows/fetch-news.yml, alongside this
 *    file) handles the schedule + running `npm install` + running this
 *    script with the secret injected as an env var — nothing further to
 *    configure beyond steps 1-5 above.
 *
 * 7. TESTING: after pushing, go to the repo's Actions tab → the
 *    "Fetch Student News" workflow → "Run workflow" (manual trigger
 *    button) → watch it run live, confirm it exits green. Then open the
 *    db3 Realtime Database console and confirm widgetConfig/news
 *    populated with real headlines/rate/weather/quote and a fresh
 *    fetchedAt timestamp — BEFORE touching any widget code. Then wait
 *    for the schedule to fire naturally once and confirm fetchedAt moves
 *    forward on its own, unattended, with your laptop closed.
 *
 * 8. If The Hindu's RSS URL (SOURCES.indiaRss) ever 403s/changes shape —
 *    this endpoint has historically been unstable to fetch from some
 *    networks/tools; if it fails in practice from GitHub's runners too,
 *    swap in another India-national RSS source (Times of India:
 *    https://timesofindia.indiatimes.com/rssfeedstopstories.cms is a
 *    documented working alternative) — everything else in this file is
 *    unaffected, it's a one-line URL swap in SOURCES.
 */
