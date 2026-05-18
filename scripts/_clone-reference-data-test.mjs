// Self-check for clone-reference-data-to-staging.mjs.
// Validates the allowlist + guard rails BEFORE doing any network I/O.
// Run: node scripts/_clone-reference-data-test.mjs

import assert from 'node:assert/strict';
import {
  ALLOWED_COLLECTIONS,
  PROD_PROJECT_ID,
  STAGING_PROJECT_ID,
  assertEnvironmentSafe,
} from './clone-reference-data-to-staging.mjs';

// 1. Allowlist contains exactly the four reference collections.
assert.deepEqual(
  [...ALLOWED_COLLECTIONS].sort(),
  ['categories', 'locations', 'settings', 'tiers']
);

// 2. PII / user-generated collections are NOT in the allowlist.
for (const forbidden of [
  'events', 'user_profiles', 'clients', 'reviews', 'trivia',
  'trivia_responses', 'checkins', 'notifications',
]) {
  assert.ok(
    !ALLOWED_COLLECTIONS.has(forbidden),
    `forbidden collection "${forbidden}" must not be in allowlist`
  );
}

// 3. Project IDs differ.
assert.notEqual(PROD_PROJECT_ID, STAGING_PROJECT_ID);

// 4. assertEnvironmentSafe throws if prod and staging keys are missing.
//    Mutates process.env; restore on the way out.
const originalProdKey = process.env.APPWRITE_PROD_READ_KEY;
const originalStagingKey = process.env.APPWRITE_STAGING_WRITE_KEY;
try {
  delete process.env.APPWRITE_PROD_READ_KEY;
  delete process.env.APPWRITE_STAGING_WRITE_KEY;
  assert.throws(() => assertEnvironmentSafe(), /APPWRITE_PROD_READ_KEY/);

  process.env.APPWRITE_PROD_READ_KEY = 'x';
  assert.throws(() => assertEnvironmentSafe(), /APPWRITE_STAGING_WRITE_KEY/);

  process.env.APPWRITE_STAGING_WRITE_KEY = 'x';
  // Should NOT throw now.
  assertEnvironmentSafe();
} finally {
  if (originalProdKey === undefined) delete process.env.APPWRITE_PROD_READ_KEY;
  else process.env.APPWRITE_PROD_READ_KEY = originalProdKey;
  if (originalStagingKey === undefined) delete process.env.APPWRITE_STAGING_WRITE_KEY;
  else process.env.APPWRITE_STAGING_WRITE_KEY = originalStagingKey;
}

console.log('✓ clone-reference-data-to-staging self-checks pass');
