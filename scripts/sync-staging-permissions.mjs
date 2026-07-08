// Sync staging collection permissions to match PROD (the live source of truth)
// for collections where the committed config had drifted. Staging was built from a
// stale config that used label:admin / empty perms for these, which 401'd the admin
// dashboard (reviews, trivia, trivia_responses). Prod actually grants `users` CRUD
// (plus read("any") on settings). This copies prod's live $permissions onto staging.
//
// Reads prod (APPWRITE_PROD_READ_KEY), writes staging (APPWRITE_STAGING_WRITE_KEY).
// Does NOT touch popups / popup_interactions (staging-only new collections not in prod).
//   node scripts/sync-staging-permissions.mjs
import { Client, Databases } from 'node-appwrite';

const ENDPOINT = 'https://nyc.cloud.appwrite.io/v1';
const PROD = '691d4a54003b21bf0136';
const STAGING = '6a0ad92e0001d5e515ce';
const DB = '69217af50038b9005a61';
const COLLECTIONS = ['trivia', 'trivia_responses', 'reviews', 'settings'];

if (!process.env.APPWRITE_PROD_READ_KEY || !process.env.APPWRITE_STAGING_WRITE_KEY) {
  console.error('Need APPWRITE_PROD_READ_KEY and APPWRITE_STAGING_WRITE_KEY exported.');
  process.exit(1);
}
if (PROD === STAGING) {
  console.error('PROD and STAGING project ids identical — refusing to run.');
  process.exit(1);
}

const prodDb = new Databases(new Client().setEndpoint(ENDPOINT).setProject(PROD).setKey(process.env.APPWRITE_PROD_READ_KEY));
const stagingDb = new Databases(new Client().setEndpoint(ENDPOINT).setProject(STAGING).setKey(process.env.APPWRITE_STAGING_WRITE_KEY));

const fmt = (a) => (a && a.length ? a.join('  ') : '(none)');

for (const id of COLLECTIONS) {
  const prodCol = await prodDb.getCollection(DB, id);
  const stagingCol = await stagingDb.getCollection(DB, id);
  const target = prodCol.$permissions || [];
  const before = stagingCol.$permissions || [];

  console.log(`\n${id}`);
  console.log(`  staging before: ${fmt(before)}`);
  console.log(`  prod (target) : ${fmt(target)}`);

  if (JSON.stringify(before.slice().sort()) === JSON.stringify(target.slice().sort())) {
    console.log('  already matches — skipping.');
    continue;
  }

  // Preserve name / documentSecurity / enabled; change only permissions.
  await stagingDb.updateCollection(DB, id, stagingCol.name, target, stagingCol.documentSecurity, stagingCol.enabled);

  const after = (await stagingDb.getCollection(DB, id)).$permissions || [];
  const ok = JSON.stringify(after.slice().sort()) === JSON.stringify(target.slice().sort());
  console.log(`  staging after : ${fmt(after)}  ${ok ? '✅' : '❌ MISMATCH'}`);
}

console.log('\nDone. Refresh the dashboard — reviews & trivia should load now.');
