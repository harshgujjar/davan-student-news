/**
 * ═══════════════════════════════════════════════════════════════════
 * BUILD VERSION: v1.3.2
 * BUILD DATE:    2026-09-08, 18:40 IST
 * ───────────────────────────────────────────────────────────────────
 * This header is bumped EVERY time this file is edited — version AND
 * date/time together, in the same edit as the code change itself. This
 * is how you tell which build you're looking at / have deployed:
 * compare this line against whatever you last pushed to GitHub Actions.
 *
 * Versioning: MAJOR.MINOR.PATCH
 *   MAJOR — a source/endpoint is added or removed (e.g. adding Nifty,
 *           dropping a news source)
 *   MINOR — new field(s) written to db3, or new fetch logic for an
 *           existing source
 *   PATCH — bug fix, wording/comment change, no new data written
 *
 * v1.3.2 (2026-09-08) — this build: the screener's server-side filters=
 *                        param is CONFIRMED NON-FUNCTIONAL after live
 *                        testing 3 different encodings, all returning
 *                        identical unfiltered results. Switched to
 *                        client-side filtering: SOURCES.screenerApi now
 *                        pulls page_size=100 sorted by market_cap desc
 *                        (no filters= param at all), and
 *                        fetchTopROEStocks() applies market_cap>=20000Cr
 *                        + debt_to_equity<=1 + 0<=ROE<=100% filters in
 *                        JS, then sorts the qualified subset by ROE desc
 *                        itself. Verified against real sample data
 *                        (RELIANCE/TCS/HDFCBANK/TITAN etc.) before
 *                        shipping — correctly surfaces real large-cap
 *                        names (TCS 45.6%, TITAN 32.3%, INFY 31.6%,
 *                        HINDUNILVR 30.7%, ITC 28.8% in one test run)
 *                        and correctly excludes the junk symbols
 *                        (SUPREMEINF 2509% ROE etc.) that a bare
 *                        sort_by=roe with no market-cap floor surfaces.
 * v1.3.1 (2026-09-08) — PATCH fix for the ROE screener (superseded by
 *                        v1.3.2 above — the market_cap/debt_to_equity
 *                        filters= param added here turned out to not
 *                        actually work; kept for changelog continuity).
 *                        Confirmed Bank Nifty's index name IS "NIFTY
 *                        BANK" (still correct, unaffected by this).
 * v1.3.0 (2026-09-08) — Bank Nifty + top-5-by-ROE fundamentals
 *                        screener added, on a NEW once-daily
 *                        post-market-close trigger (STOCK_FETCH env var)
 *                        separate from the 45-min news cycle — the
 *                        45-min cycle now preserves yesterday's stock
 *                        fields unchanged instead of fetching or wiping
 *                        them, to stay inside BharatStock's free-tier 50
 *                        req/day quota. See isStockFetchRun's own
 *                        comment in runFetchCycle() and fetch-news.yml
 *                        for the full mechanism.
 * v1.2.0 (2026-09-07) — BharatStock Nifty + CosmyDay horoscope (12 signs)
 *                        added.
 * v1.1.0 (2026-09-06) — NEWS_SOURCES multi-source-per-section rework
 *                        (bollywood/sandalwood added, per-section admin
 *                        source picker support).
 * v1.0.0 (2026-08-30) — original India/World/rate/weather/quote/gold/
 *                        silver GitHub Actions build (this header did
 *                        not exist yet at the time — v1.0.0 assigned
 *                        retroactively as the baseline this changelog
 *                        starts counting from).
 * ═══════════════════════════════════════════════════════════════════
 */

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
//   toi, ndtv                     — confirmed working by Harsha directly
//                                    in a browser (2026-09-06) — Claude's
//                                    own sandbox couldn't reach these
//                                    domains to verify independently, but
//                                    Harsha's direct check settles it.
//   indianexpress                 — fetched directly this session (Harsha
//                                    uploaded the raw response), confirmed
//                                    real XML, current headlines.
//   hindustantimes                — confirmed by Harsha uploading the raw
//                                    XML response this session; note the
//                                    real path is /feeds/rss/india-news/
//                                    rssfeed.xml, NOT /rss/topnews/... or
//                                    /rss/india-news/... (both wrong
//                                    guesses tried first — HT's actual
//                                    feed picker page at /rss confirmed
//                                    the correct pattern).
//   bbcindia                      — real, well-documented URL, still not
//                                    tested by anyone yet. Left in as a
//                                    real option since fetchRssHeadlines()'s
//                                    existing safe-failure design means a
//                                    bad URL just yields zero headlines for
//                                    that one source, not a broken run —
//                                    but treat this one specifically as
//                                    unconfirmed until tested.
const NEWS_SOURCES = {
  india: {
    thehindu: 'https://www.thehindu.com/news/national/?service=rss',
    toi: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms',
    ndtv: 'https://feeds.feedburner.com/ndtvnews-top-stories',
    indianexpress: 'https://indianexpress.com/section/india/feed/',
    hindustantimes: 'https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml',
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
  // 2026-09-07 — Page 7 horoscope. CosmyDay: free, no key, no account.
  // GET /content/daily/{sign}, sign lowercase (aries..pisces).
  // WARNING: NOT independently fetch-verified — api.cosmyday.com was
  // unreachable from the environment this was written in. Evidence it is
  // real and keyless is strong (listed in the public-apis directory; an
  // actively-maintained WordPress plugin by the same operator; the
  // reference implementation Harsha supplied calls exactly this URL) —
  // but that is evidence, not proof. Verify with:
  //   curl "https://api.cosmyday.com/content/daily/aries"
  // before trusting the output. Attribution is REQUIRED by the API's own
  // terms — the portal's horoscope card credits CosmyDay, keep that.
  horoscopeApi: 'https://api.cosmyday.com/content/daily',
  // Fallback, confirmed live 2026-09-06. Sun-sign text only, no chart.
  horoscopeFallbackApi: 'https://newastro.vercel.app',
  // 2026-09-07 — Nifty. Endpoint confirmed from BharatStock's own
  // published API reference: GET /v1/indices/{name}/prices returns
  // { trade_date, open, high, low, close }. NOTE there is no change_pct
  // field — the % move is computed from the previous row below.
  // END-OF-DAY DATA, NOT LIVE. BharatStock states plainly it is not a
  // tick-level streaming feed; prices are ingested after market close
  // each trading day. The widget labels this a "Close" for exactly that
  // reason — do not relabel it as a live price.
  niftyApi: 'https://bharatstockapi.com/v1/indices/NIFTY%2050/prices',
  // 2026-09-08 — Bank Nifty. Same endpoint shape as niftyApi, different
  // index name. NAME CONFIRMED via a live GET /v1/indices call
  // (2026-09-08): {"name":"NIFTY BANK","category":"INDICES ELIGIBLE IN
  // DERIVATIVES"} — sits in a different category than plain "NIFTY 50"
  // (also "INDICES ELIGIBLE IN DERIVATIVES", not "BROAD MARKET INDICES"
  // as first assumed), which is why an earlier check against the wrong
  // category came back empty before this was verified.
  bankNiftyApi: 'https://bharatstockapi.com/v1/indices/NIFTY%20BANK/prices',
  // 2026-09-08 — Top-by-ROE fundamentals screener, quality-filtered.
  // Sector-unrestricted (explicit admin choice — the screener has no "is
  // this a Nifty 50 constituent" field, only financial metrics), but
  // NOT filter-unrestricted: an earlier unfiltered "just sort_by=roe"
  // version surfaced nonsensical results (a live test run returned ROE
  // values of 2509%, 604%, 336% — distorted ratios from tiny/near-
  // worthless-equity companies, not genuinely excellent businesses).
  // Filters added by explicit instruction to match the quality bar of
  // the original scanner screenshot this feature was modeled on
  // (Bajaj Auto/Titan/Eicher-style large caps): market_cap > 20,000 Cr,
  // debt_to_equity < 1.0.
  //
  // FILTER PARAM CONFIRMED NON-FUNCTIONAL (2026-09-08, live testing).
  // All three encodings the OFFICIAL bharatstock Python client's docs
  // could plausibly translate to were tested directly with curl against
  // a live key, using IDENTICAL market_cap.gt.20000 /
  // debt_to_equity.lt.1 filter values each time:
  //   1. ?filters=market_cap.gt.20000&filters=debt_to_equity.lt.1
  //   2. ?filters[]=market_cap.gt.20000&filters[]=debt_to_equity.lt.1
  //   3. ?filters=%5B%22market_cap.gt.20000%22%2C%22debt_to_equity.lt.1%22%5D
  //      (URL-encoded JSON array, exactly mirroring the Python client's
  //      own input shape)
  // All three returned the IDENTICAL unfiltered result set (same 5 junk
  // symbols each time — SUPREMEINF/MBECL/GAYAPROJ/ROML/ROLLT, market_cap
  // in the hundreds of Crores, debt_to_equity as high as 11.86 — nowhere
  // near the requested filters), and total_items was unchanged at 2571
  // across all three, versus 5262 for a completely bare call — meaning
  // the filters= param has NO effect on the raw REST endpoint in any
  // tested form. The Python client's filters=[...] array must be doing
  // something the client library handles itself (client-side filtering
  // after fetch, or an entirely different wire parameter this project
  // hasn't found) rather than something the bare REST endpoint honours.
  //
  // FIX: filter and sort CLIENT-SIDE in fetchTopROEStocks() instead of
  // trusting any server-side filters= param. sort_by=market_cap (NOT
  // roe) pulls the biggest companies first — a live bare-call sample
  // confirmed real large caps (RELIANCE, TCS, HDFCBANK, TITAN, etc.) all
  // have clean, sane ROE (8-45% range) once you're actually looking at
  // real companies rather than an unsorted, unfiltered universe — so
  // sorting by market_cap first, THEN filtering/sorting the page by ROE
  // ourselves, reliably surfaces exactly the kind of results the
  // now-nonfunctional filters= param was meant to produce.
  // page_size=100 is comfortably enough large-cap names (NSE's market
  // cap distribution is steep — the top ~100 by market_cap already
  // covers everything above roughly ₹20,000 Cr with room to spare) to
  // find 5 that also pass the debt_to_equity < 1 check without needing
  // pagination.
  // market_cap filter THRESHOLD (used client-side now, not as a query
  // param) is in CRORES per the client docs' explicit note (20000 =
  // 20,000 Cr) AND confirmed directly from a live sample (RELIANCE's
  // market_cap field read 1752388.17, i.e. ~₹17.5 lakh Cr, matching its
  // real-world market cap) — do not multiply by 1e7 in the JS filter.
  screenerApi: 'https://bharatstockapi.com/v1/screener?sort_by=market_cap&sort_order=desc&exchange=NSE&page_size=100',
};

// The 12 Sun signs, lowercase. These keys MUST match what
// StudentFetchWorker.zodiacSignFromDob() and student_portal.html's
// ASTRO_SIGNS table both produce, or the widget will look up a sign that
// isn't in the map and silently show its "hasn't arrived yet" state.
const ZODIAC_SIGNS = [
  'aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo',
  'libra', 'scorpio', 'sagittarius', 'capricorn', 'aquarius', 'pisces',
];

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

// Defensive text extraction — the CosmyDay response shape is NOT
// confirmed, so this tries several plausible field names rather than
// assuming one fixed schema. Mirrors the findDeep()/positionInfo()
// approach in Harsha's own reference implementation, whose author
// clearly wrote those helpers against a moving target.
function pickHoroscopeText(obj) {
  if (obj == null) return '';
  if (typeof obj === 'string') return obj.trim();
  const keys = ['horoscope', 'description', 'text', 'content', 'daily',
                'prediction', 'overview', 'body', 'message'];
  for (const k of keys) {
    if (typeof obj[k] === 'string' && obj[k].trim()) return obj[k].trim();
  }
  for (const k of keys) {
    if (obj[k] && typeof obj[k] === 'object') {
      const nested = pickHoroscopeText(obj[k]);
      if (nested) return nested;
    }
  }
  if (obj.data) return pickHoroscopeText(obj.data);
  if (obj.result) return pickHoroscopeText(obj.result);
  return '';
}

// All 12 signs fetched ONCE per run, server-side, then written to db3 as
// a { sign: text } map. Every student widget reads that single node and
// picks its own sign locally — no device ever calls an astrology API,
// and one run covers all ~400 students regardless of how their birthdays
// happen to split across signs.
//
// Sequential with a small gap rather than Promise.all: 12 rapid-fire
// calls to a free, no-key API from one shared GitHub Actions IP is
// exactly the pattern that got rate-limited on api.gold-api.com (see
// fetchWithRetryOn429's own comment above). A missing sign is not fatal
// — the widget shows its "hasn't arrived yet" state for that sign only.
async function fetchHoroscopes() {
  const out = {};
  for (const sign of ZODIAC_SIGNS) {
    let text = '';
    try {
      const res = await fetchWithTimeout(`${SOURCES.horoscopeApi}/${sign}`);
      text = pickHoroscopeText(await res.json());
    } catch (e) {
      console.error(`fetchHoroscopes(${sign}) primary FAILED:`, e.message);
    }
    if (!text) {
      try {
        const res2 = await fetchWithTimeout(`${SOURCES.horoscopeFallbackApi}/${sign}`);
        text = pickHoroscopeText(await res2.json());
      } catch (e) {
        console.error(`fetchHoroscopes(${sign}) fallback FAILED:`, e.message);
      }
    }
    if (text) out[sign] = text;
    await sleep(400);
  }
  console.log(`fetchHoroscopes: got ${Object.keys(out).length}/12 signs`);
  return out;
}

// Nifty 50 EOD close + % change against the previous session.
//
// THE API KEY NEVER APPEARS IN THIS FILE. It is read from the
// BHARATSTOCK_API_KEY env var, injected by GitHub Actions from an
// encrypted repository secret — exactly the way
// FIREBASE_SERVICE_ACCOUNT_KEY already works in ensureFirebaseApp()
// above. This repo is public; a key committed here would be burned the
// moment it was pushed.
//
// If the secret is absent this returns empty values and logs a plain
// message rather than throwing. The widget hides the entire Nifty block
// when niftyClose is empty, so an unconfigured key degrades to "section
// simply not shown" — never to a broken run, and never to a placeholder
// number, which on a home screen would read as real market data.
//
// 2026-09-08 — extracted the shared "fetch one index's EOD close + %
// change" logic into fetchIndexEodChange() below, so Nifty 50 and Bank
// Nifty don't duplicate the same date-window/sort/prev-close-diff logic
// twice. fetchNiftyData() itself is now a thin wrapper kept for its
// existing call site + log-message wording; fetchBankNiftyData() is the
// same shape with a different SOURCES key and result field names.
async function fetchIndexEodChange(apiUrl, apiKey, label) {
  const empty = { close: '', changePct: '', date: '' };
  try {
    // Ask for a short window rather than a single day: markets are closed
    // on weekends and holidays, so "yesterday" is frequently not a
    // trading day at all. Ten days always contains at least two real
    // sessions, which is what the % change needs.
    const from = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const res = await fetchWithTimeout(`${apiUrl}?from=${from}`, {
      headers: { 'X-API-Key': apiKey },
    });
    const json = await res.json();
    // BharatStock's reference documents a { data, pagination } envelope on
    // list endpoints but shows a bare row for this particular one — accept
    // either shape rather than betting on which it really returns.
    const rows = Array.isArray(json) ? json : (json && Array.isArray(json.data) ? json.data : []);
    if (!rows.length) throw new Error('no index price rows returned');
    // Sort newest-first ourselves; do not rely on the API's ordering.
    rows.sort((a, b) => String(b.trade_date).localeCompare(String(a.trade_date)));
    const latest = rows[0];
    const prev = rows[1];
    const close = Number(latest && latest.close);
    if (!Number.isFinite(close)) throw new Error('missing/invalid close field');
    let changePct = '';
    const prevClose = Number(prev && prev.close);
    if (Number.isFinite(prevClose) && prevClose > 0) {
      const pct = ((close - prevClose) / prevClose) * 100;
      // Sign is baked in here so the widget does no arithmetic at all —
      // it only reads the leading character to pick a colour.
      changePct = (pct >= 0 ? '+' : '') + pct.toFixed(2);
    }
    return {
      close: close.toFixed(2),
      changePct,
      date: String((latest && latest.trade_date) || ''),
    };
  } catch (e) {
    console.error(`fetchIndexEodChange(${label}) FAILED:`, e.message);
    return empty;
  }
}

async function fetchNiftyData() {
  const empty = { niftyClose: '', niftyChangePct: '', niftyDate: '' };
  const apiKey = process.env.BHARATSTOCK_API_KEY;
  if (!apiKey) {
    console.log('fetchNiftyData: SKIPPED — BHARATSTOCK_API_KEY not set (Nifty section stays hidden)');
    return empty;
  }
  const r = await fetchIndexEodChange(SOURCES.niftyApi, apiKey, 'NIFTY 50');
  return { niftyClose: r.close, niftyChangePct: r.changePct, niftyDate: r.date };
}

// 2026-09-08 — Bank Nifty. Same key-gating and empty-on-failure contract
// as fetchNiftyData() above. ONLY CALLED from the once-daily post-market
// stock-fetch trigger (see runFetchCycle()'s isStockFetchRun gate below),
// never the 45-min news cycle — free BharatStock tier is 50 requests/day,
// and 45-min x 2 index calls alone would be ~96/day, already over budget
// before the screener call is even counted.
async function fetchBankNiftyData() {
  const empty = { bankNiftyClose: '', bankNiftyChangePct: '', bankNiftyDate: '' };
  const apiKey = process.env.BHARATSTOCK_API_KEY;
  if (!apiKey) {
    console.log('fetchBankNiftyData: SKIPPED — BHARATSTOCK_API_KEY not set (Bank Nifty section stays hidden)');
    return empty;
  }
  const r = await fetchIndexEodChange(SOURCES.bankNiftyApi, apiKey, 'NIFTY BANK');
  return { bankNiftyClose: r.close, bankNiftyChangePct: r.changePct, bankNiftyDate: r.date };
}

// 2026-09-08 — Top-5-by-ROE fundamentals screener, quality-filtered
// CLIENT-SIDE (see SOURCES.screenerApi's own comment for why: the
// server-side filters= query param was live-tested in three different
// encodings and confirmed to have NO effect on this endpoint). Same
// key-gating/fail-closed contract as the index fetchers above. ONLY
// CALLED from the once-daily post-market stock-fetch trigger, same
// quota reasoning as fetchBankNiftyData() — this is still exactly ONE
// API call, just page_size=100 instead of 5, so the quota math is
// unchanged.
const ROE_MIN_MARKET_CAP_CRORES = 20000;
const ROE_MAX_DEBT_TO_EQUITY = 1;

async function fetchTopROEStocks() {
  const apiKey = process.env.BHARATSTOCK_API_KEY;
  if (!apiKey) {
    console.log('fetchTopROEStocks: SKIPPED — BHARATSTOCK_API_KEY not set (ROE table stays hidden)');
    return [];
  }
  try {
    const res = await fetchWithTimeout(SOURCES.screenerApi, {
      headers: { 'X-API-Key': apiKey },
    });
    const json = await res.json();
    // /v1/screener documents a { data, pagination } envelope — same
    // defensive either-shape handling as the index endpoints above, in
    // case that ever changes.
    const rows = Array.isArray(json) ? json : (json && Array.isArray(json.data) ? json.data : []);
    const qualified = rows.filter(r => {
      // ALL THREE filtering conditions applied here in JS, since the
      // server-side filters= param does nothing (see SOURCES.screenerApi
      // comment for the live-test evidence): market cap floor and
      // debt/equity ceiling (the two quality filters explicitly
      // requested), PLUS the >100% ROE sanity guard kept as a second
      // layer of protection — a real going concern with a market cap in
      // the tens of thousands of Crores essentially never has triple or
      // quadruple digit ROE, so this also catches any data-quality
      // oddity the market_cap/debt_to_equity filters alone might miss.
      const mcap = Number(r.market_cap);
      const dte = Number(r.debt_to_equity);
      const roeNum = Number(r.roe);
      return (
        Number.isFinite(mcap) && mcap >= ROE_MIN_MARKET_CAP_CRORES &&
        Number.isFinite(dte) && dte >= 0 && dte <= ROE_MAX_DEBT_TO_EQUITY &&
        Number.isFinite(roeNum) && roeNum >= 0 && roeNum <= 100
      );
    });
    // sort_by=market_cap in the query gave us the page sorted by size,
    // not by ROE — re-sort the QUALIFIED subset by ROE desc ourselves,
    // since ROE is what "Top by ROE" is supposed to mean.
    qualified.sort((a, b) => Number(b.roe) - Number(a.roe));
    const result = qualified
      .slice(0, 5)
      .map(r => ({
        symbol: String(r.symbol || ''),
        // price/roe/pe_ratio are plain numbers in the API response — format
        // once here so the widget does zero number-formatting of its own,
        // same "format server-side, display client-side" contract as every
        // other numeric field in this file.
        price: Number.isFinite(Number(r.price)) ? Number(r.price).toLocaleString('en-IN') : '',
        roe: Number.isFinite(Number(r.roe)) ? Number(r.roe).toFixed(1) : '',
        peRatio: Number.isFinite(Number(r.pe_ratio)) ? Number(r.pe_ratio).toFixed(1) : '',
      }))
      .filter(r => r.symbol); // drop any row missing even a symbol — never show a blank row
    if (rows.length && !result.length) {
      // Every row came back but none passed the market_cap/debt_to_equity/
      // ROE checks above — with page_size=100 sorted by market_cap desc,
      // this would mean even the 100 biggest NSE companies failed the
      // debt/equity < 1 bar, which is surprising enough to be worth a
      // loud log line rather than a silently empty table. Could mean the
      // debt/equity threshold is too strict for current market
      // conditions, or that market_cap/debt_to_equity field names or
      // units have changed server-side.
      console.warn(`fetchTopROEStocks: got ${rows.length} rows (page_size=100, sorted by market_cap) but NONE passed market_cap>=${ROE_MIN_MARKET_CAP_CRORES}Cr + debt_to_equity<=${ROE_MAX_DEBT_TO_EQUITY} + ROE 0-100% — check whether the debt/equity threshold is too strict, or whether field names/units changed`);
    }
    return result;
  } catch (e) {
    console.error('fetchTopROEStocks FAILED:', e.message);
    return [];
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
  // widgetConfig/newsMaxCount lets the admin choose 1-7 headlines per
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
  //
  // 2026-09-08 — Bank Nifty / ROE screener are DELIBERATELY NOT in this
  // Promise.all. They only run on the once-daily post-market-close
  // trigger (isStockFetchRun below), never the 45-min news cycle — see
  // that flag's own comment for the full BharatStock-quota reasoning.
  const [indiaHeadlines, worldHeadlines, bollywoodHeadlines, sandalwoodHeadlines, usdInrRate, weatherLine, quoteText, goldSilver, horoscopeBySign, nifty] = await Promise.all([
    fetchSectionHeadlines('india', indiaSources, indiaMaxCount),
    fetchSectionHeadlines('world', worldSources, worldMaxCount),
    fetchSectionHeadlines('bollywood', bollywoodSources, bollywoodMaxCount),
    fetchSectionHeadlines('sandalwood', sandalwoodSources, sandalwoodMaxCount),
    fetchUsdInrRate(),
    fetchWeatherLine(),
    fetchQuoteText(),
    fetchGoldSilverRates(),
    // 2026-09-07 — both are failure-isolated exactly like every other
    // fetch here (they catch internally and return an empty value), so
    // adding them to Promise.all cannot make it reject.
    fetchHoroscopes(),
    fetchNiftyData(),
  ]);

  // 2026-09-08 — is this the once-daily stock-data run? Driven by the
  // second cron trigger in the workflow YAML (see setup notes at the
  // bottom of this file), which passes STOCK_FETCH=true as an env var.
  // Also allow a manual workflow_dispatch override via the same env var,
  // so Harsha can force a stock refresh on demand without waiting for
  // the schedule (useful right after adding/rotating the BharatStock
  // key, or after fixing the Bank Nifty index name below).
  const isStockFetchRun = process.env.STOCK_FETCH === 'true';

  // CRITICAL: this whole ref is .set() (full overwrite), not .update() —
  // see the write a few lines below. On a plain 45-min NEWS run,
  // bankNiftyClose/roeStocks are never fetched (empty by default), and a
  // naive .set() would WIPE OUT that day's stock data within 45 minutes
  // of the stock run having written it — the exact same "silently
  // discarded every cycle" failure class documented all over this
  // widget's Kotlin side (StudentWidgetPrefs.kt), just on the write side
  // instead of the cache side this time. FIX: on a non-stock run, read
  // the EXISTING node first and carry its bankNifty*/roeStocks fields
  // forward unchanged, so only the stock-fetch run ever actually changes
  // them.
  let bankNifty = { bankNiftyClose: '', bankNiftyChangePct: '', bankNiftyDate: '' };
  let roeStocks = [];
  if (isStockFetchRun) {
    [bankNifty, roeStocks] = await Promise.all([
      fetchBankNiftyData(),
      fetchTopROEStocks(),
    ]);
  } else {
    try {
      const existingSnap = await admin.database().ref('widgetConfig/news').once('value');
      const existing = existingSnap.val() || {};
      bankNifty = {
        bankNiftyClose: existing.bankNiftyClose || '',
        bankNiftyChangePct: existing.bankNiftyChangePct || '',
        bankNiftyDate: existing.bankNiftyDate || '',
      };
      roeStocks = Array.isArray(existing.roeStocks) ? existing.roeStocks : [];
    } catch (e) {
      // Read failure here just means this cycle's stock fields go blank
      // for one run (same fail-safe-empty contract as every fetch*()
      // function above) rather than blocking the whole news write —
      // headlines/gold/silver/horoscope are far more time-sensitive than
      // a once-a-day stock table staying visible for one extra 45-min
      // cycle.
      console.warn('runFetchCycle: could not read existing stock fields to preserve them:', e.message);
    }
  }

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
    // 2026-09-07 — Page 7. These field names must match
    // StudentNewsConfig.parseSnapshot() EXACTLY. That function is the
    // first point db3 data enters the widget, so a name mismatch here is
    // invisible everywhere downstream — precisely how the gold/silver
    // fields were silently dropped once before (see w69).
    horoscopeBySign,
    horoscopeDate: new Date().toISOString().slice(0, 10),
    niftyClose: nifty.niftyClose,
    niftyChangePct: nifty.niftyChangePct,
    niftyDate: nifty.niftyDate,
    // 2026-09-08 — Bank Nifty / ROE screener. See isStockFetchRun above:
    // freshly fetched on the once-daily stock run, carried forward
    // unchanged on every other run in between.
    bankNiftyClose: bankNifty.bankNiftyClose,
    bankNiftyChangePct: bankNifty.bankNiftyChangePct,
    bankNiftyDate: bankNifty.bankNiftyDate,
    // 2026-09-08 — roeStocks: NOTE that RTDB (unlike a real JSON store)
    // has no first-class empty-array representation — writing a bare []
    // here collapses to "no node written" rather than "an empty node",
    // confirmed via a live comparison (this function's own "wrote to
    // db3" log correctly showed roeStocks: [] in memory, but a direct
    // db3Get read of the actual written node moments later showed the
    // key fully ABSENT). This is expected/harmless, NOT a bug: both
    // StudentNewsConfig.parseSnapshot() (widget) and the portal's
    // db3Get-based Nifty tab already treat "key missing" identically to
    // "key present with an empty array" — see parseSnapshot()'s
    // `for (c in snapshot.child("roeStocks").children)` loop, which
    // simply iterates zero times over a missing/empty node either way.
    // So an empty roeStocks write looking "absent" in the Firebase
    // console is the correct, harmless outcome of this write — the
    // REAL question when the table is empty is always "why did
    // fetchTopROEStocks() return zero rows", not "why didn't the key
    // get written" (see that function's own >100% ROE guard comment and
    // the FAILED/ALL-filtered-out console lines for how to diagnose that).
    roeStocks,
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
    // 2026-09-07 — horoscopeSigns is the count, not the text: 12 means a
    // healthy run, 0 means BOTH CosmyDay and the newastro fallback failed
    // for every sign (a real signal worth seeing in the Actions log), and
    // anything between is a partial that still renders fine for the signs
    // that landed. niftyClose empty is EXPECTED until the
    // BHARATSTOCK_API_KEY secret is added — not an error.
    horoscopeSigns: Object.keys(horoscopeBySign).length,
    niftyClose: nifty.niftyClose,
    niftyChangePct: nifty.niftyChangePct,
    niftyDate: nifty.niftyDate,
    // 2026-09-08 — isStockFetchRun tells you at a glance from the Actions
    // log alone whether THIS run was expected to refresh stock data or
    // just carry yesterday's forward — bankNiftyClose/roeStocks empty on
    // a non-stock run is normal, not a bug, and this line is what
    // distinguishes the two cases without needing to check the workflow
    // trigger separately.
    isStockFetchRun,
    bankNiftyClose: bankNifty.bankNiftyClose,
    bankNiftyChangePct: bankNifty.bankNiftyChangePct,
    bankNiftyDate: bankNifty.bankNiftyDate,
    roeStocksCount: roeStocks.length,
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
 * ══════════════════ CHANGELOG — full detail ══════════════════
 * (short summary lives in the BUILD VERSION header at the top of this
 * file; this is the expanded version for when you need to know exactly
 * what changed and why)
 *
 * v1.3.2 — 2026-09-08, 18:40 IST
 *   Confirmed via live curl testing: the /v1/screener filters= query
 *   param has NO effect on this endpoint, in any of 3 tested encodings
 *   (repeated ?filters=...&filters=..., ?filters[]=...&filters[]=...,
 *   and a URL-encoded JSON array matching the official Python client's
 *   filters=[...] input shape). All three returned an IDENTICAL
 *   unfiltered result set (same junk symbols, same total_items count)
 *   regardless of the filter values passed.
 *   Fixed: SOURCES.screenerApi now requests page_size=100 sorted by
 *   market_cap desc, with NO filters= param at all. fetchTopROEStocks()
 *   applies market_cap>=20000 (Cr) + debt_to_equity<=1 + 0<=ROE<=100%
 *   filtering entirely in JS, then sorts the qualified subset by ROE
 *   desc itself (the market_cap sort from the query is just to bias the
 *   100-row page toward large caps, not the final display order).
 *   Verified against real sample data before shipping — correctly
 *   surfaces large-cap names with sane ROE (TCS 45.6%, TITAN 32.3%,
 *   INFY 31.6%, HINDUNILVR 30.7%, ITC 28.8% in one test) and correctly
 *   excludes the distorted-ratio junk (SUPREMEINF 2509% ROE etc.) a bare
 *   roe-desc sort surfaces.
 *   API call count UNCHANGED: still exactly 1 call for the screener
 *   (page_size=100 vs 5 doesn't cost extra requests), so the once-daily
 *   stock-fetch quota math from v1.3.0 is unaffected.
 *
 * v1.3.1 — 2026-09-08, 16:05 IST
 *   Fixed: SOURCES.screenerApi had no quality filters — a live test
 *          returned nonsensical ROE values (2509%, 604%, 336%) from
 *          tiny/distorted-equity companies sorting to the top of an
 *          unfiltered roe-desc sort. Added market_cap.gt.20000 (Crores)
 *          and debt_to_equity.lt.1 filters, using the syntax documented
 *          in BharatStock's OWN Python client (pypi.org/project/
 *          bharatstock): filters as "metric.operator.value" strings.
 *   Added: a >100% ROE sanity guard inside fetchTopROEStocks(), on top
 *          of (not instead of) the query-level filters — protects
 *          against the filters= query param being silently ignored by
 *          the API if the raw-REST encoding used here turns out to
 *          differ from what the Python client actually sends on the
 *          wire (UNVERIFIED — three alternate encodings are documented
 *          in SOURCES.screenerApi's own comment to try if
 *          fetchTopROEStocks() logs the new "ALL were filtered out"
 *          warning).
 *   Confirmed: Bank Nifty's index name IS "NIFTY BANK" — verified via a
 *          live GET /v1/indices call, returning
 *          {"name":"NIFTY BANK","category":"INDICES ELIGIBLE IN
 *          DERIVATIVES"}. v1.3.0's educated guess was correct; no
 *          change needed to SOURCES.bankNiftyApi.
 *
 * v1.3.0 — 2026-09-08, 14:20 IST
 *   Added: SOURCES.bankNiftyApi, SOURCES.screenerApi,
 *          fetchIndexEodChange() (shared logic extracted from
 *          fetchNiftyData(), which is now a thin wrapper around it),
 *          fetchBankNiftyData(), fetchTopROEStocks(). New STOCK_FETCH
 *          env var / isStockFetchRun gate in runFetchCycle() — Bank
 *          Nifty and the ROE screener are fetched ONLY on the new
 *          once-daily post-market-close cron trigger, never the 45-min
 *          news cycle. New fields written to db3:
 *          bankNiftyClose/bankNiftyChangePct/bankNiftyDate, roeStocks
 *          (array of 5 {symbol,price,roe,peRatio} objects).
 *   Why:   Free BharatStock tier is 50 requests/day. The 45-min news
 *          cycle already spends 1 call/run on Nifty 50 alone (~32/day);
 *          adding 2 more index/screener calls to that SAME cycle would
 *          have meant ~96/day, nearly double the limit. A separate
 *          once-daily trigger spends exactly 2 calls/day instead.
 *   Fixed: runFetchCycle() writes via a full .set() on widgetConfig/news,
 *          not a merge — without a fix, every 45-min NEWS-only run would
 *          have silently overwritten Bank Nifty/ROE with empty values
 *          within 45 minutes of the once-daily run having set them. Now
 *          a non-stock run reads back the existing node's stock fields
 *          first and carries them forward unchanged.
 *   Also fixed: this file's own setup notes previously said BharatStock's
 *          free tier was 100 requests/day — verified against BharatStock's
 *          actual pricing page and corrected to 50/day (see setup note 5b).
 *   Needs: Bank Nifty's exact index name ("NIFTY BANK") is an EDUCATED
 *          GUESS, not yet verified against a live key — see setup note 5d
 *          for the exact curl command to confirm it before trusting the
 *          output.
 *
 * v1.2.0 — 2026-09-07, 03:10 IST
 *   Added: SOURCES.horoscopeApi, SOURCES.horoscopeFallbackApi,
 *          SOURCES.niftyApi, ZODIAC_SIGNS, pickHoroscopeText(),
 *          fetchHoroscopes(), fetchNiftyData(). Both wired into the
 *          Promise.all fetch and the db3 payload (horoscopeBySign,
 *          horoscopeDate, niftyClose, niftyChangePct, niftyDate).
 *   Why:   Widget Page 7 (Horoscope & Nifty) needed real data behind it.
 *   Needs: BHARATSTOCK_API_KEY GitHub secret (Nifty stays hidden without
 *          it — see setup note 5b below). CosmyDay endpoints were NOT
 *          independently fetch-verified when this was written — run the
 *          curl in setup note 5c before trusting the horoscope output.
 *
 * v1.1.0 — 2026-09-06
 *   NEWS_SOURCES reworked from flat indiaRss/worldRss constants to a
 *   per-section, per-key lookup supporting multiple admin-checkable
 *   sources. Added bollywoodhungama, filmibeatkannada, bbcindia, toi,
 *   ndtv, indianexpress, hindustantimes sources. fetchSectionHeadlines()
 *   replaces the old fetchIndiaHeadlines()/fetchWorldHeadlines() pair.
 *
 * v1.0.0 — 2026-08-30 (baseline)
 *   Original build: India/World RSS, USD/INR (Frankfurter), weather
 *   (Open-Meteo), daily quote (ZenQuotes), gold/silver (goldprice.dev).
 *   GitHub Actions + Firebase service-account-key auth, chosen specifically
 *   to avoid the Blaze billing plan.
 * ═══════════════════════════════════════════════════════════════════
 */

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
 * 5b. (2026-09-07) NIFTY — OPTIONAL, add whenever you want it. Until this
 *    is done, fetchNiftyData() logs "SKIPPED" and the widget hides the
 *    Nifty block entirely. Nothing else is affected.
 *      - Get a key at https://bharatstockapi.com — the FREE tier is
 *        50 requests/day (CORRECTED 2026-09-08 — an earlier version of
 *        this note said 100, which was wrong; verified directly against
 *        BharatStock's own pricing page). This script's 45-min news
 *        cycle (~32 runs/day) spends exactly ONE call/run on Nifty 50 —
 *        well inside the 50/day budget on its own. Do not pay for a
 *        higher tier for this alone; see 5d below for why Bank Nifty/ROE
 *        needed a SEPARATE once-daily trigger rather than joining this
 *        same 45-min cycle.
 *      - GENERATE A NEW KEY. Do NOT reuse the old bsk_live_... key — it
 *        was pasted into a chat session and must be treated as
 *        compromised. Revoke it in the dashboard while you are there.
 *      - Repo -> Settings -> Secrets and variables -> Actions ->
 *        "New repository secret", name it exactly BHARATSTOCK_API_KEY.
 *      - Add it to the workflow YAML's env block alongside the Firebase
 *        one:
 *            env:
 *              FIREBASE_SERVICE_ACCOUNT_KEY: ${{ secrets.FIREBASE_SERVICE_ACCOUNT_KEY }}
 *              BHARATSTOCK_API_KEY: ${{ secrets.BHARATSTOCK_API_KEY }}
 *      - REMEMBER: BharatStock is END-OF-DAY data, not a live feed. The
 *        widget labels it "Close - <date>" for that reason.
 *
 * 5c. (2026-09-07) HOROSCOPE — no key, no secret, nothing to configure.
 *    But CosmyDay was never fetch-verified when this was written. Before
 *    trusting it, run:
 *        curl "https://api.cosmyday.com/content/daily/aries"
 *    If that returns JSON with horoscope text, the primary source works.
 *    If it 404s or times out, fetchHoroscopes() falls through to
 *    newastro.vercel.app automatically — but check the Actions log for
 *    "primary FAILED" lines, because you want to know whether you are
 *    silently running on the fallback for all 12 signs rather than
 *    assuming the primary is fine. After a run, confirm db3 has
 *    widgetConfig/news/horoscopeBySign with 12 entries BEFORE expecting
 *    anything to appear on the widget's Page 7.
 *
 * 5d. (2026-09-08) BANK NIFTY + ROE SCREENER — OPTIONAL, same
 *    BHARATSTOCK_API_KEY as 5b covers both, no separate key needed.
 *      - BANK NIFTY INDEX NAME: CONFIRMED "NIFTY BANK" via a live
 *        GET /v1/indices call (2026-09-08) — no action needed. Note it
 *        sits under category "INDICES ELIGIBLE IN DERIVATIVES", the same
 *        category as plain "NIFTY 50" — NOT "BROAD MARKET INDICES" or
 *        "SECTORAL INDICES", which is where the natural first guesses
 *        looked and came back empty.
 *      - ROE SCREENER FILTERS: market_cap>=20000 (Crores) and
 *        debt_to_equity<=1 are applied entirely CLIENT-SIDE in
 *        fetchTopROEStocks() — the /v1/screener filters= query param was
 *        CONFIRMED NON-FUNCTIONAL via live curl testing (2026-09-08),
 *        3 different encodings tried, all returned identical unfiltered
 *        results. SOURCES.screenerApi now just requests page_size=100
 *        sorted by market_cap desc (biasing the page toward large caps),
 *        and the actual filtering/sorting-by-ROE happens in JS. If this
 *        ever needs adjusting, edit ROE_MIN_MARKET_CAP_CRORES /
 *        ROE_MAX_DEBT_TO_EQUITY near fetchTopROEStocks() directly —
 *        do NOT try adding a filters= param back to the URL, it will be
 *        silently ignored by the API.
 *      - QUOTA: this section runs ONLY on the once-daily "30 10 * * *"
 *        (4pm IST, after NSE close) cron entry in fetch-news.yml — NOT
 *        the 45-min news cycle. This was a deliberate, explicit decision:
 *        the 45-min cycle already spends 1 call/run (~32/day) on Nifty
 *        50 alone; adding Bank Nifty + the screener to that SAME cycle
 *        would be 3 calls x 32 runs = 96/day, nearly double the free
 *        tier's 50/day limit. The once-daily trigger instead spends
 *        exactly 2 calls/day (Bank Nifty + screener), leaving huge
 *        headroom. On every OTHER run in between, runFetchCycle() reads
 *        back whatever the once-daily run last wrote and carries it
 *        forward unchanged — see isStockFetchRun's own comment in
 *        runFetchCycle() for exactly how.
 *      - MANUAL TEST: Actions tab -> "Fetch Student News" -> "Run
 *        workflow" -> tick the "stock_fetch" checkbox before running, to
 *        force a stock refresh on demand instead of waiting for 4pm IST.
 *      - Confirm db3 has widgetConfig/news/bankNiftyClose and
 *        /roeStocks (an array of 5 {symbol,price,roe,peRatio} objects)
 *        populated after a stock-fetch run, same as step 7 below for the
 *        rest of the payload.
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
