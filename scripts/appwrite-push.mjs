/**
 * Push Appwrite resources to a NAMED environment, safely.
 *
 * The problem this solves: `appwrite push` reads appwrite.config.json from the
 * working directory, and the committed one at appwrite/appwrite.config.json
 * carries the PRODUCTION project id. So running `appwrite push tables` from the
 * admin repo deploys to production — there is no --project-id flag to say
 * otherwise. The workspace-root appwrite.config.json points at staging but
 * holds no schema, so it cannot push either.
 *
 * This script derives a config for the requested environment from the single
 * committed schema (swapping only projectId/projectName/endpoint) into a temp
 * directory, and runs the CLI there. The committed config is never mutated, so
 * there is no "remember to revert" step to forget.
 *
 * Usage (from samplefinder-admin):
 *   node scripts/appwrite-push.mjs --env staging --resource tables
 *   node scripts/appwrite-push.mjs --env staging --resource tables --dry-run
 *   node scripts/appwrite-push.mjs --env prod    --resource tables
 *
 * Requires the Appwrite CLI to be logged in (`appwrite login`).
 * Pushing to prod requires --yes, so it cannot happen by reflex.
 */
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_CONFIG = join(__dirname, '../appwrite/appwrite.config.json');

/**
 * Environments. Project ids are public identifiers, not secrets — they are
 * already in the committed config and the app's .env.
 */
const ENVIRONMENTS = {
  prod: {
    projectId: '691d4a54003b21bf0136',
    projectName: 'SampleFinder',
    label: 'PRODUCTION',
  },
  staging: {
    projectId: '6a0ad92e0001d5e515ce',
    projectName: 'Samplefinder (Staging)',
    label: 'staging',
  },
};

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (flag) => argv.includes(flag);

const envName = argOf('--env');
const resource = argOf('--resource', 'tables');
const dryRun = has('--dry-run');
/**
 * Restrict the push to specific resource ids. Strongly preferred: an unscoped
 * `push tables` syncs ALL tables to the committed schema, which would silently
 * revert any drift that exists only in the target project.
 */
const onlyId = argOf('--id');

if (!envName || !ENVIRONMENTS[envName]) {
  console.error(`
Usage: node scripts/appwrite-push.mjs --env <staging|prod> [--resource tables] [--dry-run]

  --env       which Appwrite project to deploy to (required)
  --resource  what to push: tables (default), buckets, teams, functions
  --dry-run   show the resolved target and diff summary, push nothing
  --yes       required to actually push to prod
`);
  process.exit(1);
}

if (!existsSync(SOURCE_CONFIG)) {
  console.error(`Source config not found: ${SOURCE_CONFIG}`);
  process.exit(1);
}

const target = ENVIRONMENTS[envName];
const source = JSON.parse(readFileSync(SOURCE_CONFIG, 'utf8'));

// Guard: the committed config must still be the prod one we expect. If someone
// hand-edited projectId, bail rather than deploy a surprise.
if (source.projectId !== ENVIRONMENTS.prod.projectId) {
  console.error(`
Refusing to run: ${SOURCE_CONFIG} has projectId "${source.projectId}",
but this script expects the committed production id "${ENVIRONMENTS.prod.projectId}".

Someone may have swapped it by hand. Restore it (git checkout the file), then
re-run — this script sets the target project itself and never needs the
committed file changed.
`);
  process.exit(1);
}

const derived = { ...source, projectId: target.projectId, projectName: target.projectName };

const tables = derived.tables || [];
const userProfiles = tables.find((t) => t.$id === 'user_profiles');
const phoneVerified = (userProfiles?.columns || userProfiles?.attributes || []).find(
  (c) => c.key === 'phoneVerified'
);

console.log(`\n── Appwrite push → ${target.label}`);
console.log(`   project   ${target.projectId}  (${target.projectName})`);
console.log(`   resource  ${resource}`);
console.log(`   schema    ${tables.length} tables, from the committed prod config`);
console.log(
  `   phoneVerified on user_profiles: ${
    phoneVerified
      ? `present (${phoneVerified.type}, required=${phoneVerified.required}, default=${phoneVerified.default})`
      : 'ABSENT — nothing to deploy'
  }`
);

if (envName === 'prod' && !has('--yes')) {
  console.error('\nRefusing to push to PRODUCTION without --yes.\n');
  process.exit(1);
}

if (dryRun) {
  console.log('\n--dry-run: nothing was pushed.\n');
  process.exit(0);
}

const workDir = mkdtempSync(join(tmpdir(), `appwrite-push-${envName}-`));
writeFileSync(join(workDir, 'appwrite.config.json'), JSON.stringify(derived, null, 4));

// ── PRE-FLIGHT: refuse to run if the target has tables the config does not ──
//
// `appwrite push tables` treats the config as the desired FULL state: any table
// that exists remotely but not locally is DELETED. `--id` does not prevent this
// (it only filters which tables are offered for push), and `--force` silently
// auto-confirms the deletions.
//
// This already destroyed `popups` and `popup_interactions` on staging once.
// Those tables live on a feature branch whose schema is not in the branch being
// deployed, so the config legitimately lacked them — and the push removed them.
//
// So: enumerate the target's tables first and abort if it holds anything the
// config does not. Restoring means merging that branch's schema in, not forcing.
if (resource === 'tables') {
  const probe = mkdtempSync(join(tmpdir(), `appwrite-probe-${envName}-`));
  writeFileSync(
    join(probe, 'appwrite.config.json'),
    JSON.stringify({ projectId: target.projectId, endpoint: derived.endpoint }, null, 2)
  );
  const dbId = derived.tablesDB?.[0]?.$id || derived.databases?.[0]?.$id;
  const listed = spawnSync(
    'appwrite',
    ['databases', 'list-collections', '--database-id', dbId, '--json'],
    { cwd: probe, encoding: 'utf8', env: process.env }
  );

  let remoteIds = null;
  try {
    const parsed = JSON.parse(listed.stdout || '');
    remoteIds = (parsed.collections || parsed.tables || []).map((c) => c.$id);
  } catch {
    /* fall through to the hard stop below */
  }

  if (!remoteIds) {
    console.error(`
Could not read the target project's existing tables, so the destructive-push
guard cannot run. Refusing to continue — an unguarded push can DELETE tables.

  ${(listed.stderr || listed.stdout || '').trim().split('\n').slice(-2).join('\n  ')}
`);
    process.exit(1);
  }

  const localIds = new Set(tables.map((t) => t.$id));
  const wouldDelete = remoteIds.filter((id) => !localIds.has(id));

  console.log(`   target has ${remoteIds.length} tables; config defines ${localIds.size}`);

  if (wouldDelete.length) {
    console.error(`
REFUSING TO PUSH — this would DELETE ${wouldDelete.length} table(s) from ${target.label}:

  ${wouldDelete.join('\n  ')}

They exist in the target but not in this branch's appwrite.config.json, and
push deletes anything not in the config. Deletion destroys the rows too, and
these projects have no backup policy configured.

Fix by making the config a superset before pushing — e.g. merge the branch that
defines those tables — then re-run.
`);
    process.exit(1);
  }
}

// --force only AFTER the guard above has proven no table would be deleted. It
// is required because the CLI otherwise prompts interactively and would hang in
// a non-interactive run — but on its own it silently confirms deletions.
const cliArgs = ['push', resource, '--force'];
if (onlyId) cliArgs.push('--id', onlyId);

console.log(`\n   staged config in ${workDir}`);
console.log(`   endpoint  ${derived.endpoint}`);
console.log(`   scope     ${onlyId ? `--id ${onlyId}` : 'ALL ' + resource + ' (unscoped)'}`);
if (!onlyId) {
  console.log('   ! unscoped push overwrites every table in the target with the');
  console.log('     committed schema, reverting any target-only drift.');
}
console.log(`   running: appwrite ${cliArgs.join(' ')}\n`);

const res = spawnSync('appwrite', cliArgs, {
  cwd: workDir,
  stdio: 'inherit',
  env: { ...process.env, APPWRITE_ENDPOINT: derived.endpoint },
});

if (res.error) {
  console.error(`\nFailed to run the Appwrite CLI: ${res.error.message}`);
  console.error('Is it installed and on PATH? Try: appwrite --version\n');
  process.exit(1);
}

console.log(
  res.status === 0
    ? `\nPushed ${resource} to ${target.label}.\n`
    : `\nCLI exited ${res.status}. Nothing further attempted.\n`
);
process.exit(res.status ?? 1);
