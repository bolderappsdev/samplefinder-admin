// Seed the FIRST admin user in STAGING.
//
// Chicken-and-egg: the admin dashboard's "add user" UI needs an admin to log in,
// but a fresh staging project has none. This invokes the SAME server path the UI
// uses — the Mobile API function's POST /create-user — which creates the Auth user
// AND the user_profiles row (role: admin, isBlocked: false, unique referralCode,
// welcome points). The function creates them with its own staging APPWRITE key.
//
// Idempotent / re-runnable:
//   - If the email already exists WITH a profile → reports it (promotes to admin if needed).
//   - If it exists as a profile-less orphan (a prior partial failure) → deletes it and retries.
//
// Required env:
//   APPWRITE_STAGING_WRITE_KEY  — staging API key (needs users + tables + execution scopes)
//   STAGING_ADMIN_EMAIL         — email for the new staging admin
//   STAGING_ADMIN_PASSWORD      — password (>= 8 chars); kept in your shell, never on the CLI
// Optional env:
//   STAGING_ADMIN_FIRSTNAME     — default "Staging"
//   STAGING_ADMIN_LASTNAME      — default "Admin"
//
// Run:  node scripts/seed-staging-admin.mjs

import { Client, Functions, Users, Databases, Query, ExecutionMethod } from 'node-appwrite';

const ENDPOINT = 'https://nyc.cloud.appwrite.io/v1';
const STAGING_PROJECT_ID = '6a0ad92e0001d5e515ce';
const PROD_PROJECT_ID = '691d4a54003b21bf0136';
const DB = '69217af50038b9005a61';
const USER_PROFILES_TABLE = 'user_profiles';
// Same id in prod & staging (config-push model pins explicit $ids).
const MOBILE_API_FUNCTION_ID = '69308117000e7a96bcbb';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assertSafe() {
  if (!process.env.APPWRITE_STAGING_WRITE_KEY) throw new Error('APPWRITE_STAGING_WRITE_KEY is not set. Export the staging API key first.');
  if (!process.env.STAGING_ADMIN_EMAIL) throw new Error('STAGING_ADMIN_EMAIL is not set.');
  if (!process.env.STAGING_ADMIN_PASSWORD) throw new Error('STAGING_ADMIN_PASSWORD is not set.');
  if (process.env.STAGING_ADMIN_PASSWORD.length < 8) throw new Error('STAGING_ADMIN_PASSWORD must be at least 8 characters.');
  if (STAGING_PROJECT_ID === PROD_PROJECT_ID) throw new Error('Staging and prod project ids are identical — refusing to run.');
}

const email = (process.env.STAGING_ADMIN_EMAIL || '').trim().toLowerCase();

function buildBody() {
  return {
    email,
    password: process.env.STAGING_ADMIN_PASSWORD,
    firstname: process.env.STAGING_ADMIN_FIRSTNAME || 'Staging',
    lastname: process.env.STAGING_ADMIN_LASTNAME || 'Admin',
    username: '',
    phoneNumber: '',
    role: 'admin',
    tierLevel: '',
    totalPoints: 100,
    dob: '',
    zipCode: '',
    avatarURL: '',
  };
}

async function callCreateUser(functions) {
  const execution = await functions.createExecution({
    functionId: MOBILE_API_FUNCTION_ID,
    xpath: '/create-user',
    method: ExecutionMethod.POST,
    body: JSON.stringify(buildBody()),
    headers: { 'Content-Type': 'application/json' },
    async: false,
  });
  const httpStatus = Number(execution.responseStatusCode) || 0;
  let parsed = {};
  try {
    parsed = JSON.parse(execution.responseBody || '{}');
  } catch {
    /* leave parsed empty */
  }
  return { execution, httpStatus, parsed };
}

function reportSuccess(parsed) {
  console.log('\n✅ Staging admin created.');
  console.log(`   authUserId : ${parsed.userId}`);
  console.log(`   profileId  : ${parsed.profileId}`);
  console.log(`   email      : ${email}`);
  console.log('   role       : admin');
  console.log('\nLog into the staging dashboard with this email + the password you set.');
}

async function main() {
  assertSafe();

  const client = new Client().setEndpoint(ENDPOINT).setProject(STAGING_PROJECT_ID).setKey(process.env.APPWRITE_STAGING_WRITE_KEY);
  const functions = new Functions(client);
  const users = new Users(client);
  const databases = new Databases(client);

  console.log(`Seeding staging admin "${email}" via Mobile API POST /create-user`);
  console.log(`  project=${STAGING_PROJECT_ID} function=${MOBILE_API_FUNCTION_ID}\n`);

  let { execution, httpStatus, parsed } = await callCreateUser(functions);
  console.log(`execution ${execution.$id}: status=${execution.status} httpStatus=${httpStatus}`);

  if (execution.status !== 'completed') {
    console.error('\n❌ Function did not complete.');
    if (execution.errors) console.error('errors:', execution.errors);
    if (execution.logs) console.error('logs:', execution.logs);
    process.exit(1);
  }

  if (parsed.success) {
    reportSuccess(parsed);
    return;
  }

  // Conflict: the email already exists in Auth. Distinguish a real account from an orphan.
  if (httpStatus === 409) {
    console.log(`\n"${email}" already exists in staging Auth. Checking whether it has a profile...`);
    const found = await users.list({ queries: [Query.equal('email', [email])] });
    if (found.total > 0) {
      const authUser = found.users[0];
      const profiles = await databases.listDocuments({
        databaseId: DB,
        collectionId: USER_PROFILES_TABLE,
        queries: [Query.equal('authID', [authUser.$id])],
      });

      if (profiles.total === 0) {
        console.log(`  Orphan Auth user (no profile) from a prior partial failure — deleting ${authUser.$id} and retrying...`);
        await users.delete({ userId: authUser.$id });
        await sleep(1000);
        ({ execution, httpStatus, parsed } = await callCreateUser(functions));
        console.log(`  retry execution ${execution.$id}: status=${execution.status} httpStatus=${httpStatus}`);
        if (parsed.success) {
          reportSuccess(parsed);
          return;
        }
        console.error(`\n❌ Retry failed (httpStatus=${httpStatus}): ${parsed.error || 'unknown error'}`);
        process.exit(1);
      }

      // Real, complete account already exists.
      const existing = profiles.documents[0];
      console.log(`\nℹ️  ${email} already has a full account (profileId=${existing.$id}, role=${existing.role}).`);
      if (existing.role !== 'admin') {
        console.log('   role is not "admin" — promoting to admin...');
        await databases.updateDocument({
          databaseId: DB,
          collectionId: USER_PROFILES_TABLE,
          documentId: existing.$id,
          data: { role: 'admin' },
        });
        console.log('   ✅ promoted to admin.');
      }
      console.log('\nLog into the staging dashboard with this email + its existing password.');
      return;
    }
  }

  console.error(`\n❌ create-user failed (httpStatus=${httpStatus}): ${parsed.error || 'unknown error'}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
