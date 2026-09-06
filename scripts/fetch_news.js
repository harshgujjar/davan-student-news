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

// NEWS_SOURCES (2026-09-06): per-section, per-key RSS URL lookup —
// replaces the old flat indiaRss/worldRss constants now that sections
// support multiple admin-checkable sources (student_portal.html's new
// "News & Rates" tab, widgetConfig/newsSourceConfig). Keys here MUST
// match the data-source values used in that portal's checkboxes exactly.
//
// Verification status (2026-09-06 session):
//   thehindu, bbcworld            — ALREADY confirmed working, live in
//                                    production before this change.
//   bollywoodhungama, filmibeatkannada — fetched directly this session,
//                                    confirmed real XML, current headlines.
//   toi, ndtv, bbcindia           — real, well-documented URLs (multiple
//                                    independent sources agree on them),
//                                    but NOT fetched directly this session
//                                    — the sandbox used to build this file
//                                    was blocked from reaching these
//                                    domains. Left in as real options
//                                    since fetchRssHeadlines()'s existing
//                                    safe-failure design means a bad URL
//                                    here just yields zero headlines for
//                                    that one source, not a broken run —
//                                    but treat these three as unconfirmed
//                                    until you see real headlines from
//                                    them in a live GitHub Actions run.
const NEWS_SOURCES = {
  india: {
    thehindu: 'https://www.thehindu.com/news/national/?service=rss',
    toi: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms',
    ndtv: 'https://feeds.feedburner.com/ndtvnews-top-stories',
  },
  world: {
    bbcworld: 'https://feeds.bbci.co.uk/news/world/rss.xml',
    bbcindia: 'https://feeds.bbci.co.uk/news/world/asia/india/rss.xml',
  },
  bollywood: {
    bollywoodhungama: 'https://www.bollywoodhungama.com/rss/news.xml',
  },
  sandalwood: {
    filmibeatkannada: 'https://kannada.filmibeat.com/rss/feeds/filmibeat-kannada-fb.xml',
  },
};

const SOURCES = {
  rateApi: 'https://api.frankfurter.dev/v2/rate/USD/INR',
  // Davangere, Karnataka coordinates (matches Harsha's meter.html location context)
  weatherApi: 'https://api.open-meteo.com/v1/forecast?latitude=14.4644&longitude=75.9218&current=temperature_2m,weather_code&timezone=Asia%2FKolkata',
  quoteApi: 'https://zenquotes.io/api/today',
  // goldprice.dev — free, no-key, documented, verified live 2026-09-06
  // (api.gold-api.com was the original choice but every route on that
  // domain returned "Symbol not found"/plain-text 404s when tested
  // directly in a browser — it appears to no longer serve XAU/XAG the
  // way earlier notes assumed. See W68 gold/silver debugging session).
  // /v1/carat returns 24k/22k per-gram price directly in the requested
  // currency — no manual troy-ounce/FX math needed on our side.
  goldCaratApi: 'https://api.goldprice.dev/v1/carat?currency=INR',
  // /v1/convert does XAG -> INR per-gram directly; we ask for 10 grams
  // so the result is already "per 10g" without further math.
  silverConvertApi: 'https://api.goldprice.dev/v1/convert?from=XAG&to=INR&amount=10&unit=gram',
};

const FETCH_TIMEOUT_MS = 10000;

// Small delay helper — used by fetchWithRetryOn429() and to stagger the
// gold/silver calls in fetchGoldSilverRates() below.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


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

// Retries a single fetchWithTimeout call on HTTP 429 specifically
// (rate-limited), waiting `delayMs` before each retry. Any other error
// (network failure, timeout, non-429 HTTP error) is NOT retried — it
// rethrows immediately, since a retry wouldn't help those cases. Used
// only by fetchGoldSilverRates(), which found api.gold-api.com's free
// tier rejects requests spaced even 1.5s apart (HTTP 429, confirmed via
// GitHub Actions runs #47 and #48, 2026-09-06) — retrying once with a
// longer wait covers the case where the limit is a short rolling
// window rather than a same-instant burst check.
async function fetchWithRetryOn429(url, opts = {}, maxRetries = 2, delayMs = 5000) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchWithTimeout(url, opts);
    } catch (e) {
      lastErr = e;
      const is429 = /HTTP 429/.test(e.message);
      if (!is429 || attempt === maxRetries) throw e;
      console.log(`fetchWithRetryOn429: got 429 for ${url}, retry ${attempt + 1}/${maxRetries} after ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
  throw lastErr;
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

// Generic multi-source section fetcher (2026-09-06) — replaces the old
// fetchIndiaHeadlines()/fetchWorldHeadlines() pair now that any section
// can have 1+ admin-checked sources (see NEWS_SOURCES + portal's News &
// Rates tab). Fetches every enabled source for the section in parallel,
// merges results, de-dupes by exact title match (multiple sources
// covering the same story is common — e.g. a shared wire report), then
// returns the top `maxCount` headlines. A single source failing (bad
// URL, feed down, malformed XML) never blocks the others — each
// individual fetch is wrapped, same safe-failure principle as
// fetchRssHeadlines()'s own per-item handling.
//
// Order after merging is "whichever source's headlines came first in
// enabledSources order" rather than a true cross-source chronological
// sort — RSS feeds don't reliably expose comparable timestamps across
// different publishers' formats, so a naive date-sort risked being
// wrong in a way that's hard to notice. Good enough for a widget
// headline strip; not presented as a strict global timeline.
async function fetchSectionHeadlines(sectionKey, enabledSourceKeys, maxCount = 4) {
  const sectionSources = NEWS_SOURCES[sectionKey] || {};
  const urls = enabledSourceKeys
    .map((key) => sectionSources[key])
    .filter(Boolean);

  if (urls.length === 0) return [];

  const perSourceMax = maxCount; // fetch up to maxCount from EACH source, then trim the merged/deduped result down to maxCount overall
  const results = await Promise.all(
    urls.map((url) =>
      fetchRssHeadlines(url, perSourceMax).catch((e) => {
        console.error(`fetchSectionHeadlines(${sectionKey}) source FAILED: ${url} —`, e.message);
        return [];
      })
    )
  );

  const seen = new Set();
  const merged = [];
  for (const list of results) {
    for (const headline of list) {
      const key = headline.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(headline);
      if (merged.length >= maxCount) break;
    }
    if (merged.length >= maxCount) break;
  }
  return merged;
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

// Gold/Silver rates via goldprice.dev (free, no key, verified live and
// documented 2026-09-06 — see SOURCES comment above for why this
// replaced api.gold-api.com, which turned out to no longer serve
// XAU/XAG despite earlier notes assuming it did).
//
// /v1/carat already returns per-gram 24k/22k prices in whatever
// ?currency= is requested — no manual troy-ounce or FX math needed on
// our side, unlike the old api.gold-api.com approach. Multiplied by 10
// here for "per 10 grams" to match the widget's existing display unit.
// /v1/convert does the same for silver: asking for amount=10, unit=gram
// returns silver's INR value for exactly 10 grams directly.
// Both are documented "No auth required · Free+" — genuinely no API key.
//
// Silver shown as BOTH per-10g (to match gold's unit on a small widget
// face — Harsha's original 2026-09-01 choice) AND per-kg (Harsha's
// 2026-09-06 request, alongside the per-10g figure, not replacing it).
// silverRateKg is derived as silverPer10g * 100 rather than a third API
// call — 10g -> 1000g is a clean x100 multiply, no separate /v1/convert
// call needed (same "reuse what we already fetched" principle as
// usdInrRate not needing a second FX call elsewhere in this file).
// AUTO-FETCH ONLY: unlike India/World/quote/weather, there is no admin
// override path for these fields — Harsha's explicit choice.
// Whole block hides on the widget unless the 3 core values (24K/22K/
// silver-per-10g) are present, so on ANY failure here this returns
// empty strings for all four rather than partial data (partial data
// reads as more confusing than none). silverRateKg specifically is
// still derived even on a "success" path — it can never be non-empty
// while silverRate is empty, since it's computed directly from it.
//
// Sequential with a short gap (not the api.gold-api.com 429 issue, but
// keeping the pattern defensive since this is still a free-tier API run
// from a shared GitHub Actions IP).
async function fetchGoldSilverRates() {
  const empty = { gold24Rate: '', gold22Rate: '', silverRate: '', silverRateKg: '' };
  try {
    const caratRes = await fetchWithRetryOn429(SOURCES.goldCaratApi);
    const caratData = await caratRes.json();
    await sleep(1000);
    const silverRes = await fetchWithRetryOn429(SOURCES.silverConvertApi);
    const silverData = await silverRes.json();

    const gold24PerGram = caratData && parseFloat(caratData.price_gram_24k);
    const gold22PerGram = caratData && parseFloat(caratData.price_gram_22k);
    const silverPer10g = silverData && parseFloat(silverData.result);

    if (!Number.isFinite(gold24PerGram) || !Number.isFinite(gold22PerGram) || !Number.isFinite(silverPer10g)) {
      throw new Error('missing/invalid price field in goldprice.dev response');
    }

    return {
      gold24Rate: (gold24PerGram * 10).toFixed(0),
      gold22Rate: (gold22PerGram * 10).toFixed(0),
      silverRate: silverPer10g.toFixed(0),
      silverRateKg: (silverPer10g * 100).toFixed(0),
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

  // Max-count config (2026-09-06): portal-side chip selector at
  // widgetConfig/newsMaxCount lets the admin choose 4-7 headlines per
  // section, independently per section. Absent (never set, or an older
  // portal build) => 4, same "absent means the old default" convention
  // as pageEnabled/newsOverride elsewhere in this file.
  const maxCountSnap = await admin.database().ref('widgetConfig/newsMaxCount').once('value');
  const maxCountConfig = maxCountSnap.val() || {};
  const indiaMaxCount = Number(maxCountConfig.india) || 4;
  const worldMaxCount = Number(maxCountConfig.world) || 4;
  const bollywoodMaxCount = Number(maxCountConfig.bollywood) || 4;
  const sandalwoodMaxCount = Number(maxCountConfig.sandalwood) || 4;

  // Source config (2026-09-06): widgetConfig/newsSourceConfig, written by
  // the portal's News & Rates tab checkboxes — which RSS source(s) feed
  // each section. Absent (never configured, or an older portal build)
  // falls back to the single source each section had before this feature
  // existed, so an admin who never opens this new UI keeps getting
  // exactly the same India/World/Bollywood/Sandalwood behavior as before.
  const sourceConfigSnap = await admin.database().ref('widgetConfig/newsSourceConfig').once('value');
  const sourceConfig = sourceConfigSnap.val() || {};
  const defaultSources = {
    india: ['thehindu'],
    world: ['bbcworld'],
    bollywood: ['bollywoodhungama'],
    sandalwood: ['filmibeatkannada'],
  };
  const indiaSources = (sourceConfig.india && sourceConfig.india.enabledSources) || defaultSources.india;
  const worldSources = (sourceConfig.world && sourceConfig.world.enabledSources) || defaultSources.world;
  const bollywoodSources = (sourceConfig.bollywood && sourceConfig.bollywood.enabledSources) || defaultSources.bollywood;
  const sandalwoodSources = (sourceConfig.sandalwood && sourceConfig.sandalwood.enabledSources) || defaultSources.sandalwood;

  // All eight fetches now run fully in parallel — fetchGoldSilverRates()
  // no longer needs usdInrRate as an input (goldprice.dev converts to
  // INR itself via ?currency=/?to=), so the earlier "fetch usdInrRate
  // first, then the rest" ordering is no longer necessary. All fetch*()
  // functions here are failure-isolated (they catch internally and
  // return a safe empty value), so Promise.all is safe: none of them
  // ever reject.
  const [indiaHeadlines, worldHeadlines, bollywoodHeadlines, sandalwoodHeadlines, usdInrRate, weatherLine, quoteText, goldSilver] = await Promise.all([
    fetchSectionHeadlines('india', indiaSources, indiaMaxCount),
    fetchSectionHeadlines('world', worldSources, worldMaxCount),
    fetchSectionHeadlines('bollywood', bollywoodSources, bollywoodMaxCount),
    fetchSectionHeadlines('sandalwood', sandalwoodSources, sandalwoodMaxCount),
    fetchUsdInrRate(),
    fetchWeatherLine(),
    fetchQuoteText(),
    fetchGoldSilverRates(),
  ]);

  const payload = {
    indiaHeadlines,
    worldHeadlines,
    bollywoodHeadlines,
    sandalwoodHeadlines,
    usdInrRate,
    weatherLine,
    quoteText,
    gold24Rate: goldSilver.gold24Rate,
    gold22Rate: goldSilver.gold22Rate,
    silverRate: goldSilver.silverRate,
    silverRateKg: goldSilver.silverRateKg,
    fetchedAt: Date.now(),
  };

  await admin.database().ref('widgetConfig/news').set(payload);

  console.log('runFetchCycle: wrote to db3', {
    indiaCount: indiaHeadlines.length,
    indiaMaxCount,
    indiaSources,
    worldCount: worldHeadlines.length,
    worldMaxCount,
    worldSources,
    bollywoodCount: bollywoodHeadlines.length,
    bollywoodMaxCount,
    sandalwoodCount: sandalwoodHeadlines.length,
    sandalwoodMaxCount,
    usdInrRate,
    weatherLine,
    hasQuote: !!quoteText,
    gold24Rate: goldSilver.gold24Rate,
    gold22Rate: goldSilver.gold22Rate,
    silverRate: goldSilver.silverRate,
    silverRateKg: goldSilver.silverRateKg,
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
