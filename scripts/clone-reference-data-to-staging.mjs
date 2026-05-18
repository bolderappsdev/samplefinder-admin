// Clone reference data (non-PII) from PROD Appwrite project to STAGING.
//
// Reads (with a read-only API key) from PROD project 691d4a54003b21bf0136.
// Writes (with a write API key) to STAGING project 6a0ad92e0001d5e515ce.
// Allowlist: categories, locations, tiers, settings. Nothing else.
//
// Required env:
//   APPWRITE_PROD_READ_KEY      — read-only key on prod
//   APPWRITE_STAGING_WRITE_KEY  — read+write key on staging
//
// Run:
//   node scripts/clone-reference-data-to-staging.mjs
//   (idempotent: re-running upserts, no duplicates created)

import { Client, Databases, Query, ID } from 'node-appwrite';

export const PROD_PROJECT_ID = '691d4a54003b21bf0136';
export const STAGING_PROJECT_ID = '6a0ad92e0001d5e515ce';
export const ENDPOINT = 'https://nyc.cloud.appwrite.io/v1';
export const DATABASE_ID = '69217af50038b9005a61';
export const ALLOWED_COLLECTIONS = new Set([
  'categories',
  'locations',
  'tiers',
  'settings',
]);

const APPWRITE_MANAGED_FIELDS = [
  '$createdAt',
  '$updatedAt',
  '$permissions',
  '$collectionId',
  '$databaseId',
];

export function assertEnvironmentSafe() {
  if (!process.env.APPWRITE_PROD_READ_KEY) {
    throw new Error(
      'APPWRITE_PROD_READ_KEY is not set. Export a READ-ONLY prod API key first.'
    );
  }
  if (!process.env.APPWRITE_STAGING_WRITE_KEY) {
    throw new Error(
      'APPWRITE_STAGING_WRITE_KEY is not set. Export a write staging API key first.'
    );
  }
  if (PROD_PROJECT_ID === STAGING_PROJECT_ID) {
    throw new Error(
      'PROD_PROJECT_ID and STAGING_PROJECT_ID are identical — refusing to run.'
    );
  }
}

function stripManaged(doc) {
  const cleaned = { ...doc };
  for (const k of APPWRITE_MANAGED_FIELDS) delete cleaned[k];
  delete cleaned.$id;
  return cleaned;
}

async function listAllDocuments(databases, collectionId) {
  const all = [];
  let cursor = null;
  while (true) {
    const queries = [Query.limit(100)];
    if (cursor) queries.push(Query.cursorAfter(cursor));
    const res = await databases.listDocuments(DATABASE_ID, collectionId, queries);
    all.push(...res.documents);
    if (all.length >= res.total || res.documents.length === 0) break;
    cursor = res.documents[res.documents.length - 1].$id;
  }
  return all;
}

async function upsertDocument(databases, collectionId, $id, data) {
  try {
    await databases.updateDocument(DATABASE_ID, collectionId, $id, data);
    return 'updated';
  } catch (err) {
    if (Number(err?.code) === 404) {
      await databases.createDocument(DATABASE_ID, collectionId, $id, data);
      return 'created';
    }
    throw err;
  }
}

async function main() {
  assertEnvironmentSafe();

  const prodClient = new Client()
    .setEndpoint(ENDPOINT)
    .setProject(PROD_PROJECT_ID)
    .setKey(process.env.APPWRITE_PROD_READ_KEY);
  const prodDb = new Databases(prodClient);

  const stagingClient = new Client()
    .setEndpoint(ENDPOINT)
    .setProject(STAGING_PROJECT_ID)
    .setKey(process.env.APPWRITE_STAGING_WRITE_KEY);
  const stagingDb = new Databases(stagingClient);

  console.log(`Cloning reference data ${PROD_PROJECT_ID} → ${STAGING_PROJECT_ID}`);
  console.log(`Allowlist: ${[...ALLOWED_COLLECTIONS].join(', ')}\n`);

  const summary = {};
  for (const collectionId of ALLOWED_COLLECTIONS) {
    const docs = await listAllDocuments(prodDb, collectionId);
    console.log(`${collectionId}: read ${docs.length} docs from prod`);

    let created = 0;
    let updated = 0;
    for (const doc of docs) {
      const result = await upsertDocument(
        stagingDb,
        collectionId,
        doc.$id,
        stripManaged(doc)
      );
      if (result === 'created') created++;
      else updated++;
    }
    summary[collectionId] = { read: docs.length, created, updated };
    console.log(`  → staging: ${created} created, ${updated} updated\n`);
  }

  console.log('Summary:');
  console.table(summary);
}

// Only run main() when invoked directly, not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('FAILED:', err);
    process.exit(1);
  });
}
