// Temporary probe: prints what each candidate rate source returns. Writes nothing anywhere.
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36', 'Accept': 'text/html,application/json' };
const text = (h) => h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#8377;|&#x20b9;/gi, ' ').replace(/\s+/g, ' ');
async function get(u) { const c = new AbortController(); setTimeout(() => c.abort(), 25000); const r = await fetch(u, { headers: UA, signal: c.signal }); return { status: r.status, body: await r.text() }; }
function ctx(t, re, n = 6, w = 160) { const out = []; let m; const g = new RegExp(re, 'gi'); while ((m = g.exec(t)) && out.length < n) out.push('…' + t.slice(Math.max(0, m.index - w), m.index + w) + '…'); return out; }
(async () => {
  const pages = [
    ['GR gold', 'https://www.goodreturns.in/gold-rates/davangere.html', ['24K', '22K', 'Updated', 'as on']],
    ['GR silver', 'https://www.goodreturns.in/silver-rates/davangere.html', ['1 kg', '10 gram', 'Updated', 'as on']],
    ['IBJA', 'https://ibjarates.com/', ['999', '916', 'Silver', 'AM', 'PM']],
  ];
  for (const [name, u, keys] of pages) {
    try {
      const { status, body } = await get(u); const t = text(body);
      console.log(`\n===== ${name} ${status} html=${body.length} text=${t.length}`);
      for (const k of keys) { console.log(`--- [${k}]`); ctx(t, k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 4).forEach((s) => console.log(s)); }
      if (name === 'IBJA') { const ids = body.match(/id="[^"]*(?:lbl|rate|Rate|Gold|Silver)[^"]*"[^>]*>[^<]{0,40}/g) || []; console.log('--- IDS'); ids.slice(0, 60).forEach((s) => console.log(s)); }
      if (name.startsWith('GR')) { const tb = body.match(/<table[\s\S]{0,3000}?<\/table>/g) || []; console.log('--- TABLES', tb.length); tb.slice(0, 3).forEach((s) => console.log(s.replace(/\s+/g, ' ').slice(0, 1500))); }
    } catch (e) { console.log(`\n===== ${name} FAILED ${e.message}`); }
  }
  for (const u of ['https://open.er-api.com/v6/latest/USD', 'https://api.frankfurter.dev/v2/rate/AED/INR', 'https://api.frankfurter.dev/v2/rate/USD/INR', 'https://api.goldprice.dev/v1/carat?currency=INR']) {
    try { const { status, body } = await get(u); let j = body; try { const o = JSON.parse(body); if (o.rates) o.rates = { INR: o.rates.INR, AED: o.rates.AED, THB: o.rates.THB, SAR: o.rates.SAR }; j = JSON.stringify(o); } catch (e) {} console.log(`\n===== ${u} ${status}\n${j.slice(0, 800)}`); }
    catch (e) { console.log(`\n===== ${u} FAILED ${e.message}`); }
  }
})();
