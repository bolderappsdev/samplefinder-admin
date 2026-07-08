# Staging Environment — Setup Status

**Last updated:** 2026-07-03
**Branch (admin repo):** `feature/staging-environment`
**Design spec:** [`docs/superpowers/specs/2026-07-03-staging-environment-design.md`](./superpowers/specs/2026-07-03-staging-environment-design.md)
**Plan A (backend + admin):** [`docs/superpowers/plans/2026-07-03-staging-backend-and-admin.md`](./superpowers/plans/2026-07-03-staging-backend-and-admin.md)

> Living tracker. **Legend:** ✅ done · 🟡 in progress · ⏭️ deferred (safe to skip for now) · ⛔ blocked (waiting on access) · ⬜ pending

---

## TL;DR

The staging **Appwrite backend is ~90% mirrored** to prod: all 15 tables + columns, the storage bucket, all 3 serverless functions (deployed, scoped, scheduled) and their env vars, and auth methods are done. Reference data is cloned (categories 21, locations 330, tiers 5, settings 15), a staging **admin user is seeded** (`tillo@bolderapps.com`), and the **admin smoke test PASSED** — login works and every page loads from staging (after adding a `localhost` CORS platform and syncing collection permissions from prod). **The staging backend + admin dashboard are verified working.** What remains is **one test event** (via the UI, 2 min) plus the **mobile app (Plan B — not started)** and the **FCM push provider** (blocked on Firebase Console access, safely deferred — push is only testable once the staging mobile app exists).

---

## Core facts

| Thing | Prod | Staging |
|---|---|---|
| Appwrite project id | `691d4a54003b21bf0136` | `6a0ad92e0001d5e515ce` ("Samplefinder (Staging)") |
| Endpoint | `https://nyc.cloud.appwrite.io/v1` | *same* |
| Database id | `69217af50038b9005a61` | *same* |
| Storage bucket | `6921b4ae002feef4b15e` (`files`) | *same* |
| Mobile API function | `69308117000e7a96bcbb` | *same* |
| Statistics function | `69341ffa001a4ebd28c2` | *same* |
| Notification function | `695d55bb002bc6b75430` | *same* |
| FCM provider id | `69cac0a30038ed1a7b92` | *plan: create with same id* |
| Firebase project | `simplefinder-29ed7` (sender `569742468290`) | *reuse the same project* |
| Mobile bundle id | `com.samplefinder.app` | `com.samplefinder.app.staging` (planned) |

**Guiding principle:** `appwrite.config.json` pins explicit resource `$id`s, so a push reproduces identical ids in staging — **only the project id differs**. This is why the admin `.env.staging` and (planned) mobile staging build are nearly identical to prod.

**Prod-safety protocol (never violated):**
- All Appwrite CLI writes use a **project-scoped staging key** (physically cannot touch prod) and push from a config whose `projectId` = staging.
- The **only** operation that reads prod is the reference-data clone below, and it uses a **read-only** prod key.
- The clean staging config used for pushes lives at `$CLAUDE_JOB_DIR/tmp/staging-push/appwrite.config.json` (projectId=staging; big-int column bounds preserved via string-replace, **not** `JSON.parse`/`stringify`, which corrupts the 5× `2^63-1` bounds on `user_profiles`/`reviews`).

---

## Phase 1 — Backend (Appwrite staging)

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Staging + prod API keys created | ✅ | Staging full-access key in use; prod READ-ONLY key confirmed working (clone succeeded). |
| 2 | CLI pinned to staging (prod-safe) | ✅ | Verified: pushes land in staging, never prod. |
| 3 | Audit staging (DB, tables, bucket, functions) | ✅ | |
| 4 | Tables / schema parity | ✅ | All **15** tables present (13 shared + `popups` + `popup_interactions`), columns built out & verified 0-missing via `scripts/_inspect-staging-schema.mjs`. Fixed one attribute (`user_profiles.lastname`) stuck in `processing` from the corrupted early push — deleted & recreated on the 0-row table (safe). `locations.location` point default fixed to `null`. |
| 5 | Storage bucket parity | ✅ | `push buckets` → "No changes"; staging `files` already matches (50MB, `users` CRUD, encryption+antivirus). |
| 6 | Functions deployed + scopes + schedule | ✅ | All 3 `live/ready`; scopes match config; Notification cron `*/15 * * * *` set. |
| 7 | Function env vars | ✅ | `APPWRITE_API_KEY` (staging key) on all 3 + `APPWRITE_NOTIFICATION_FUNCTION_ID=695d55bb002bc6b75430` on Mobile API. `TRIVIA_ONLY_TUESDAY_ET` / `NOTIFICATION_APPEND_DEADLINE_MS` / `TZ` deliberately unset (defaults ideal for QA). |
| 8 | FCM push provider | ⛔ | **Blocked on Firebase Console access** (requested). Deferred — see below. |
| 9 | Auth methods | ✅ | Email/Password + Email OTP enabled. App is **email-based** (`createEmailToken` + `createEmailPasswordSession`) — **no SMS / mock numbers / SMTP needed**; Appwrite's default email service delivers OTP. (`push settings` via CLI needs a console session, so auth was verified/toggled in the console UI instead.) |
| 10 | Clone reference data | ✅ | Cloned prod→staging: categories 21, locations 330, tiers 5, settings 15. Required widening staging `settings.value` `10000`→`10000000` to match prod (prod col is `string(10M)`=TEXT; longest value 28965 chars). Recreated the empty staging column — no data loss. |
| 11 | Seed test event + admin user | 🟡 | **Admin seeded** via `scripts/seed-staging-admin.mjs` → `tillo@bolderapps.com`, role `admin` (profileId `6a47dded0039b47de6d0`). Script invokes Mobile API `POST /create-user` (same path the UI uses) and is idempotent (auto-cleans profile-less orphans). **Test event still to create via the UI** during the smoke test. |
| 15 | Admin runtime smoke test | ✅ | Login + all pages load from staging (categories 21, locations 330, tiers 5, settings; reviews/trivia after the permission sync; **dashboard statistics load when warm**). Prereqs discovered & applied: a `localhost` **Web platform** (CORS) and syncing 4 collections' permissions from prod (`scripts/sync-staging-permissions.mjs`). A one-off `500 general_unknown` from Statistics was a cold-start transient (crashed before its first log line, concurrent with a successful call), not a config issue. |

---

## Phase 2 — Admin dashboard

| Task | Status | Notes |
|---|---|---|
| `.env.staging` (gitignored) + `.env.staging.example` | ✅ | Identical to prod except `VITE_APPWRITE_PROJECT_ID`. |
| `dev:staging` / `build:staging` scripts (`vite --mode staging`) | ✅ | In `package.json`. |
| Verified staging build bundles staging project id | ✅ | |

---

## Phase 3 — Mobile app (Plan B) — NOT STARTED

Separate side-by-side app (distinct bundle id, name suffix), both iOS + Android, with push. Plan B has **not been written** yet (deferred until backend verified). Anticipated work:

- Convert `app.json` → `app.config.js` with an `APP_VARIANT` switch (staging → `com.samplefinder.app.staging`, name suffix).
- Variant-aware deep-link / babel / `@env` wiring; staging `.env` (`EXPO_PUBLIC_*`).
- Register the staging app (**Android + iOS**) in Firebase `simplefinder-29ed7`; ship staging `google-services.json` / `GoogleService-Info.plist`.
- Point the staging build at the staging FCM provider (or create the staging provider with the **same id** `69cac0a30038ed1a7b92` so the app default works with no change).
- Build runbook: Android APKs shared directly for test (cost-sensitive); iOS via EAS. ⚠️ Native dirs are gitignored — signing/manifest fixes get wiped by `prebuild` and must be reapplied each release.

---

## ⛔ Blocked / waiting on you

1. **Firebase Console access** (requested) → needed for the FCM provider (Task 8) and the Plan-B Firebase app registration. Requires access to project `simplefinder-29ed7` with rights to generate a service-account key.
*(Prod read-only key confirmed working — the clone succeeded.)*

---

## 🔧 Follow-ups (non-blocking)

1. **Repo config drift — `settings.value` size.** The committed `appwrite/appwrite.config.json` still declares `settings.value` as `string(10000)`, but prod (and now staging) is `string(10000000)`. Update the repo config to `10000000` so future pushes/rebuilds match reality. ⚠️ Do **not** push the repo config to **prod** solely for this — prod already has the correct 10M column.

2. **Repo config drift — collection permissions (⚠️ HIGHER RISK — could break prod).** The committed config's `$permissions` are stale for several collections vs prod (verified 2026-07-03 via `scripts/_inspect-permissions.mjs`):

   | Collection | committed config | prod (live, correct) |
   |---|---|---|
   | `trivia` | `label:admin` CRUD | `users` CRUD |
   | `trivia_responses` | *(none)* | `users` CRUD |
   | `reviews` | *(none)* | `users` CRUD |
   | `settings` | `users` CRUD | `users` CRUD + `read("any")` |

   Staging was built from the stale config, so the admin dashboard 401'd on trivia/reviews until fixed. **Staging is now synced to prod** via `scripts/sync-staging-permissions.mjs`. ⚠️ **NEVER `appwrite push` the committed config to PROD** as-is — it would overwrite prod's `trivia`/`trivia_responses`/`reviews` permissions with `label:admin`/none (locking authenticated users out) and drop `settings`' public `read("any")`. Update the repo config to match prod **before** any future prod push. (`popups`/`popup_interactions` are staging-only new collections not yet in prod — leave their `label:admin`/none as designed.)

---

## ▶️ Next actions (in order — all doable now, no Firebase needed)

### 1. ✅ Clone reference data (Task 10) — DONE
Copied non-PII reference data (`categories, locations, tiers, settings`) prod → staging. Idempotent (re-runnable).

```bash
cd samplefinder-admin
export APPWRITE_PROD_READ_KEY='<read-only prod key>'      # read scopes ONLY
export APPWRITE_STAGING_WRITE_KEY='<staging write key>'   # the staging key you already have
node scripts/clone-reference-data-to-staging.mjs
```
Prints a per-collection summary (read / created / updated). Safe: allowlisted collections only; refuses to run if either key is missing or if prod == staging.

### 2. 🟡 Seed admin user (Task 11) — admin DONE, test event pending
- ✅ **Admin account created**: `node scripts/seed-staging-admin.mjs` (env: `STAGING_ADMIN_EMAIL`, `STAGING_ADMIN_PASSWORD`, `APPWRITE_STAGING_WRITE_KEY`). Seeded `tillo@bolderapps.com` / role `admin`. Idempotent & re-runnable.
- ⬜ Create at least one **test event** via the admin UI once logged in (step 3) so the mobile app (later) has content.

### 3. ✅ Admin smoke test (Task 15) — DONE
Login + all pages load from staging; dashboard stats load when warm. Prereqs that were needed: a `localhost` **Web platform** in staging Appwrite (CORS) and syncing collection permissions from prod (`scripts/sync-staging-permissions.mjs`). **Remaining half of Task 11:** create one test event via the admin UI (see step 2).
```bash
cd samplefinder-admin
npm run dev:staging
```
Log in with the staging admin account; verify events, users, trivia, categories, locations load from staging (not prod).

---

## ⏭️ Deferred: FCM / push (unblock when Firebase access lands)

**Why it's safe to skip now:** the FCM provider only *delivers* push. Push can't be exercised end-to-end until the staging mobile app exists (Plan B), so nothing on the current critical path depends on it.

**When you get Firebase access:**
1. Firebase Console → project `simplefinder-29ed7` → ⚙️ Project settings → **Service accounts** → **Generate new private key** (safe; does not revoke prod's existing key). Downloads a JSON — treat as a secret.
2. Staging Appwrite console → **Messaging → Providers → Create provider → Push → FCM**. Set the **Provider ID** to `69cac0a30038ed1a7b92` (same as prod, so the app's default works), paste the service-account JSON, **Enable**.
3. Full push validation happens during Plan B (mobile).
