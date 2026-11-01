// Adds (once) the rules for Gujjar Home Class to DB3, keeping every other rule as it is.
//   homeclass/<familyKey>  read/write only with the 24+ character family key (the root cannot be listed)
//   hcpair/<6 digits>       short pairing codes (valid 15 min, made by the parent app)
// Idempotent: run again = no change. Saves the old rules as the run's artifact (old-db3-rules).
const admin = require('firebase-admin');
const fs = require('fs');
const URL = 'https://davan-student-news-default-rtdb.asia-southeast1.firebasedatabase.app';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)), databaseURL: URL });
function stripComments(s) { // rules text may have // and /* */ comments and trailing commas
  let o = '', i = 0, q = false;
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (q) { o += c; if (c === '\\') { o += n; i += 2; continue; } if (c === '"') q = false; i++; continue; }
    if (c === '"') { q = true; o += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
    o += c; i++;
  }
  return o.replace(/,(\s*[}\]])/g, '$1');
}
const WANT = {
  homeclass: { '$fam': { '.read': '$fam.length >= 24', '.write': '$fam.length >= 24' } },
  hcpair: { '$code': { '.read': true,
    '.write': "$code.matches(/^[0-9]{6}$/) && (!data.exists() || !newData.exists() || data.child('exp').val() < now || newData.child('fam').val() == data.child('fam').val())",
    '.validate': "!newData.exists() || (newData.child('fam').isString() && newData.child('fam').val().length >= 24 && newData.child('exp').isNumber())" } }
};
(async () => {
  const tok = (await admin.app().options.credential.getAccessToken()).access_token;
  const txt = await (await fetch(URL + '/.settings/rules.json?access_token=' + tok)).text();
  fs.writeFileSync('old-rules.json', txt);
  console.log('old rules: ' + txt.length + ' chars');
  const r = JSON.parse(stripComments(txt));
  let changed = false;
  for (const k of Object.keys(WANT)) {
    if (JSON.stringify(r.rules[k]) !== JSON.stringify(WANT[k])) { console.log((r.rules[k] ? 'replace' : 'add') + ' rules.' + k); r.rules[k] = WANT[k]; changed = true; }
  }
  if (!changed) { console.log('already there - nothing to do'); process.exit(0); }
  const put = await fetch(URL + '/.settings/rules.json?access_token=' + tok, { method: 'PUT', body: JSON.stringify(r, null, 2) });
  console.log('PUT ' + put.status + ' ' + (await put.text()).slice(0, 300));
  process.exit(put.ok ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
