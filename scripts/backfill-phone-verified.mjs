/**
 * Grandfather existing users: set user_profiles.phoneVerified = true for every
 * row that is not already true. Idempotent — safe to run multiple times.
 * Requires a server API key with rows.read and rows.write on user_profiles.
 *
 * Usage (from samplefinder-admin):
 *   APPWRITE_API_KEY=... node scripts/backfill-phone-verified.mjs --dry-run
 *   APPWRITE_API_KEY=... node scripts/backfill-phone-verified.mjs
 */
import { Client, TablesDB, Query } from 'node-appwrite';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = join(__dirname, '../.env');
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadEnv();

const endpoint = process.env.VITE_APPWRITE_ENDPOINT || process.env.APPWRITE_ENDPOINT;
const projectId = process.env.VITE_APPWRITE_PROJECT_ID || process.env.APPWRITE_PROJECT_ID;
const apiKey = process.env.APPWRITE_API_KEY;
const databaseId = process.env.VITE_APPWRITE_DATABASE_ID || '69217af50038b9005a61';
const userProfilesTable = process.env.VITE_APPWRITE_COLLECTION_USER_PROFILES || 'user_profiles';

const DRY_RUN = process.argv.includes('--dry-run');

if (!endpoint || !projectId || !apiKey) {
  console.error(
    'Set VITE_APPWRITE_ENDPOINT, VITE_APPWRITE_PROJECT_ID, and APPWRITE_API_KEY (optionally in .env).'
  );
  process.exit(1);
}

const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
const tablesDB = new TablesDB(client);

async function main() {
  let offset = 0;
  const page = 100;
  let updated = 0;

  for (;;) {
    const res = await tablesDB.listRows({
      databaseId,
      tableId: userProfilesTable,
      queries: [Query.limit(page), Query.offset(offset)],
    });
    const rows = res.rows || [];
    if (rows.length === 0) break;

    for (const row of rows) {
      if (row.phoneVerified === true) continue;

      if (DRY_RUN) {
        console.log(`[dry-run] ${row.$id} -> phoneVerified = true`);
        updated++;
        continue;
      }

      await tablesDB.updateRow({
        databaseId,
        tableId: userProfilesTable,
        rowId: row.$id,
        data: { phoneVerified: true },
      });
      console.log(`Updated ${row.$id} -> phoneVerified = true`);
      updated++;
    }

    if (rows.length < page) break;
    offset += page;
  }

  console.log(
    DRY_RUN ? `Dry run: would update ${updated} profile(s).` : `Done. Updated ${updated} profile(s).`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
