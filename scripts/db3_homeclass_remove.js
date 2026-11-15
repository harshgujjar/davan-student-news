// Removes Home Class families from DB3 FOR EVER, only when the user said yes (davan-attendance CLAUDE.md: never delete without asking).
// 1. prints exactly what goes, 2. saves a full copy as the run's artifact (removed-families.json, kept by GitHub 90 days),
// 3. deletes homeclass/<key>, 4. adds a rule homeclass/<key> = no read / no write, so an old phone can never re-create it.
// Inputs: KEYS (comma separated family keys), CONFIRM must be "DELETE <number of keys>".
const admin = require('firebase-admin');
const fs = require('fs');
const URL = 'https://davan-student-news-default-rtdb.asia-southeast1.firebasedatabase.app';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)), databaseURL: URL });
const keys = String(process.env.KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
(async () => {
  if (!keys.length || keys.some(k => !/^[A-Za-z0-9_-]{24,64}$/.test(k))) throw new Error('bad keys');
  if (process.env.CONFIRM !== 'DELETE ' + keys.length) throw new Error('CONFIRM must be "DELETE ' + keys.length + '" - nothing done');
  const db = admin.database(), backup = {};
  for (const k of keys) {
    const v = (await db.ref('homeclass/' + k).once('value')).val();
    backup[k] = v;
    const kids = Object.values((v && v.cfg && v.cfg.kids) || {}).map(x => x && x.name).join(', ');
    console.log('…' + k.slice(-4) + ': name "' + ((v && v.cfg && v.cfg.famName) || '') + '" · children ' + (kids || '-') + ' · devices ' + Object.keys((v && v.dev) || {}).length + ' · parts ' + Object.keys(v || {}).join(',') + ' · ' + JSON.stringify(v || {}).length + ' chars');
  }
  fs.writeFileSync('removed-families.json', JSON.stringify(backup));
  for (const k of keys) { await db.ref('homeclass/' + k).remove(); console.log('removed …' + k.slice(-4)); }
  const tok = (await admin.app().options.credential.getAccessToken()).access_token;
  const r = await (await fetch(URL + '/.settings/rules.json?access_token=' + tok)).json();
  r.rules.homeclass = r.rules.homeclass || {};
  for (const k of keys) r.rules.homeclass[k] = { '.read': false, '.write': false };
  const put = await fetch(URL + '/.settings/rules.json?access_token=' + tok, { method: 'PUT', body: JSON.stringify(r, null, 2) });
  console.log('rules: blocked ' + keys.length + ' key(s) · PUT ' + put.status);
  for (const k of keys) { const again = (await db.ref('homeclass/' + k).once('value')).val(); console.log('check …' + k.slice(-4) + ': ' + (again === null ? 'gone' : 'STILL THERE')); }
  process.exit(put.ok ? 0 : 1);
})().catch(e => { console.error(e.message); process.exit(1); });
