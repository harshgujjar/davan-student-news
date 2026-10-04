// Temporary: runs the real rate functions from fetch_news.js. No database writes.
const f = require('../scripts/fetch_news.js');
(async () => {
  console.log('GOLD', JSON.stringify(await f.fetchGoldSilverRates()));
  console.log('USD', await f.fetchUsdInrRate(), 'AED', await f.fetchUsdInrRate(f.SOURCES.aedRateApi));
})();
