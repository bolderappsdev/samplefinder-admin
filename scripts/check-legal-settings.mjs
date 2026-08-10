/**
 * Inspect (and optionally replace) the legal documents the mobile app actually
 * shows users.
 *
 * The app does NOT show src/constants/LegalContent.ts when a database row
 * exists: PrivacyModal/TermsModal call getSetting('privacy_policy') and
 * getSetting('termsAndCondition') and only fall back to the bundled constant
 * when the row is missing. So fixing the constant alone does not fix what
 * users — or an A2P reviewer following your opt-in flow — actually read.
 *
 * Usage (from samplefinder-admin):
 *   # report what is live
 *   APPWRITE_API_KEY=... node scripts/check-legal-settings.mjs
 *
 *   # replace a document from a text file (creates the row if absent)
 *   APPWRITE_API_KEY=... node scripts/check-legal-settings.mjs \
 *     --set privacy_policy --from ./privacy.txt
 *
 * Requires a server API key with rows.read (and rows.write for --set).
 */
import { Client, TablesDB, Query } from 'node-appwrite';
import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
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
const settingsTable = process.env.VITE_APPWRITE_COLLECTION_SETTINGS || 'settings';

if (!endpoint || !projectId || !apiKey) {
  console.error('Missing Appwrite config. Need endpoint, project id and APPWRITE_API_KEY.');
  process.exit(1);
}

const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : undefined;
};
const setKey = argOf('--set');
const fromFile = argOf('--from');

if (setKey && !fromFile) {
  console.error('--set requires --from <file>');
  process.exit(1);
}

const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
const tablesDB = new TablesDB(client);

/** Keys the mobile app reads, with the screen that reads them. */
const LEGAL_KEYS = [
  { key: 'privacy_policy', label: 'Privacy Policy', reader: 'PrivacyModal' },
  { key: 'termsAndCondition', label: 'Terms & Conditions', reader: 'TermsModal' },
];

/** Markers that mean the document was never finished. */
const PLACEHOLDER_PATTERNS = [/\[Add your complete/i, /lorem ipsum/i, /TODO/];

/** Language A2P 10DLC review looks for. Absence is why error 30908 fires. */
const REQUIRED_SIGNALS = [
  { label: 'mentions SMS/text messaging', re: /\b(sms|text message)\b/i },
  { label: 'non-sharing clause (share/sell + mobile)', re: /do not share, sell,? or provide your mobile/i },
  { label: 'message frequency disclosed', re: /message frequency/i },
  { label: 'rates disclosure', re: /rates may apply/i },
  { label: 'HELP / STOP instructions', re: /\bSTOP\b/ },
];

async function findRow(key) {
  const res = await tablesDB.listRows({
    databaseId,
    tableId: settingsTable,
    queries: [Query.equal('key', key)],
  });
  return res.rows?.[0] ?? null;
}

// ── write mode ───────────────────────────────────────────────────────────────
if (setKey) {
  const path = resolve(process.cwd(), fromFile);
  if (!existsSync(path)) {
    console.error(`File not found: ${path}`);
    process.exit(1);
  }
  const value = readFileSync(path, 'utf8');
  const existing = await findRow(setKey);

  if (existing) {
    console.log(`Updating "${setKey}" (row ${existing.$id}) — ${existing.value?.length ?? 0} -> ${value.length} chars`);
    await tablesDB.updateRow({
      databaseId,
      tableId: settingsTable,
      rowId: existing.$id,
      data: { value },
    });
  } else {
    console.log(`Creating "${setKey}" — ${value.length} chars`);
    await tablesDB.createRow({
      databaseId,
      tableId: settingsTable,
      rowId: 'unique()',
      data: { key: setKey, value, description: `${setKey} shown in the mobile app` },
    });
  }
  console.log('Done. Re-run without --set to verify.');
  process.exit(0);
}

// ── report mode ──────────────────────────────────────────────────────────────
console.log('\n══ LEGAL DOCUMENTS THE APP ACTUALLY SHOWS ══\n');

let problems = 0;

for (const { key, label, reader } of LEGAL_KEYS) {
  const row = await findRow(key);
  console.log(`── ${label}  (key: ${key}, read by ${reader})`);

  if (!row) {
    console.log('   NOT IN DATABASE — the app falls back to the bundled');
    console.log('   src/constants/LegalContent.ts copy.');
    console.log('   That fallback is only in the app bundle, so it is still not');
    console.log('   reachable by an A2P reviewer. Publish it at a public URL.\n');
    continue;
  }

  const value = row.value || '';
  console.log(`   row ${row.$id}, ${value.length} chars, updated ${row.$updatedAt}`);

  const placeholder = PLACEHOLDER_PATTERNS.find((p) => p.test(value));
  if (placeholder) {
    problems++;
    console.log(`   ✗ UNFINISHED — matches ${placeholder}`);
  }

  for (const sig of REQUIRED_SIGNALS) {
    const ok = sig.re.test(value);
    if (!ok && key === 'privacy_policy') problems++;
    console.log(`   ${ok ? '✓' : '✗'} ${sig.label}`);
  }
  console.log('');
}

console.log('── NEXT ' + '─'.repeat(56));
if (problems === 0) {
  console.log('Database copies look compliant. Confirm the SAME text is live at a');
  console.log('public, login-free URL and that the URL is on the campaign.');
} else {
  console.log(`${problems} issue(s). The privacy policy must be finished, must cover SMS,`);
  console.log('and must carry the non-sharing clause, or A2P review fails with 30908.');
  console.log('\nTo push corrected text:');
  console.log('  node scripts/check-legal-settings.mjs --set privacy_policy --from ./privacy.txt');
}
console.log('');
process.exit(problems === 0 ? 0 : 1);
