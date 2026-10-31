// READ ONLY: print DB3 (davan-student-news) nodes. Never writes. PATHS comma separated (add ?shallow for keys only), MAXC max characters.
const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)),
  databaseURL: 'https://davan-student-news-default-rtdb.asia-southeast1.firebasedatabase.app' });
const maxc = parseInt(process.env.MAXC || '20000', 10);
(async () => {
  for (const raw of (process.env.PATHS || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const shallow = raw.endsWith('?shallow'), path = raw.replace('?shallow', '');
    let v;
    if (shallow) {
      const tok = (await admin.app().options.credential.getAccessToken()).access_token;
      const r = await fetch(admin.app().options.databaseURL + '/' + path + '.json?shallow=true&access_token=' + tok);
      v = await r.json();
    } else v = (await admin.database().ref(path).once('value')).val();
    console.log('=== ' + path + (shallow ? ' (shallow)' : '') + ' ===');
    console.log(JSON.stringify(v, null, 1).slice(0, maxc));
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
