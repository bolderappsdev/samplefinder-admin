# Staging Environment — Plan A: Backend + Admin

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to work this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. NOTE: this is an **operations/config** plan, not a code-TDD plan — most tasks are executed by the user against live consoles/CLI, and each task's "test" is a concrete verification command + expected output rather than a unit test.

**Goal:** Verify and complete the staging Appwrite project (`6a0ad92e0001d5e515ce`) so it mirrors prod, then wire the admin dashboard to run/build against it.

**Architecture:** Push the committed `appwrite/appwrite.config.json` (15 tables, `files` bucket, 3 functions, auth settings) into the staging project via the Appwrite CLI, set per-environment function secrets + messaging/auth providers in the console, clone non-PII reference data with the existing script, then create the admin `.env.staging` (identical to prod except the project ID).

**Tech Stack:** Appwrite Cloud (NYC region), Appwrite CLI v14.0.0, `node-appwrite` 24 (clone script), Vite `--mode staging` (admin).

## Global Constraints

- **Only the project ID differs** prod→staging: `691d4a54003b21bf0136` (prod) → `6a0ad92e0001d5e515ce` (staging). Endpoint `https://nyc.cloud.appwrite.io/v1`, DB `69217af50038b9005a61`, bucket `6921b4ae002feef4b15e`, functions Mobile API `69308117000e7a96bcbb` / Statistics `69341ffa001a4ebd28c2` / Notification `695d55bb002bc6b75430`, and all table slugs are **identical** in both projects.
- **Never** commit an API key or put a server key in any client bundle. Staging keys live only in the user's shell / a gitignored local file / the Appwrite console.
- **Prod-safety invariant:** all CLI work uses a **staging-scoped API key** only. Appwrite API keys are per-project, so a staging key cannot authenticate against prod even if a command is mis-targeted. The console session (prod-capable) is logged out before any push.
- Endpoint must be the **regional** `https://nyc.cloud.appwrite.io/v1` (the CLI's stored default is the generic `cloud.appwrite.io` — wrong for this project).
- Work happens on branch `feature/staging-environment` in `samplefinder-admin`.

## Owner legend

- 🤖 **Claude** — in-repo file changes / builds, no secrets. Claude can do these directly.
- 👤 **User (CLI)** — a credentialed CLI command. Run it in your own terminal (or via the `! <cmd>` prompt prefix) so keys stay out of the transcript. Paste the output back.
- 🖥️ **Console** — a click-path in the Appwrite / Firebase web console. Claude gives exact navigation; you perform it.

---

## PHASE 1 — Backend (verify + complete staging Appwrite)

### Task 1: Create staging credentials 👤🖥️

**Goal:** have the API keys the rest of Phase 1 needs, stored safely.

- [ ] **Step 1 — Create a staging server API key.** Appwrite Console → switch to the **staging** project (`6a0ad92e0001d5e515ce`) → **Overview → Integrations → API Keys → Create API key**. Name `staging-cli-fullaccess`. Scopes: select **all** of `databases.*`, `tables.*`, `collections.*`, `documents.*`, `rows.*`, `buckets.*`, `files.*`, `functions.*`, `execution.*`, `users.*`, `teams.*`, `messaging.*`, `providers.*`, `targets.*`, `topics.*`, `settings.*`. Copy the secret.
- [ ] **Step 2 — Create a prod READ-ONLY API key** (for the reference-data clone in Task 10). Switch to the **prod** project (`691d4a54003b21bf0136`) → API Keys → Create. Name `prod-readonly-clone`. Scopes: **only** `databases.read`, `tables.read`, `collections.read`, `documents.read`, `rows.read`. Copy the secret.
- [ ] **Step 3 — Stash them in a gitignored local file** (not committed, not the repo's tracked env files):

```bash
cat > "$HOME/.samplefinder-staging.env" <<'EOF'
export APPWRITE_STAGING_API_KEY="<paste staging-cli-fullaccess secret>"
export APPWRITE_STAGING_WRITE_KEY="<same staging key is fine>"
export APPWRITE_PROD_READ_KEY="<paste prod-readonly-clone secret>"
EOF
chmod 600 "$HOME/.samplefinder-staging.env"
```

- [ ] **Verify:** `source "$HOME/.samplefinder-staging.env" && [ -n "$APPWRITE_STAGING_API_KEY" ] && echo "keys loaded"` → prints `keys loaded`.

### Task 2: Pin the CLI to staging (SAFETY GATE) 👤

**Goal:** guarantee every subsequent CLI command targets staging, never prod.

- [ ] **Step 1 — Drop the prod-capable console session:**

```bash
appwrite logout || true
appwrite client --reset
```

- [ ] **Step 2 — Pin the client to staging with the staging key:**

```bash
source "$HOME/.samplefinder-staging.env"
appwrite client \
  --endpoint "https://nyc.cloud.appwrite.io/v1" \
  --project-id "6a0ad92e0001d5e515ce" \
  --key "$APPWRITE_STAGING_API_KEY"
```

- [ ] **Step 3 — Confirm the pinned config:**

Run: `appwrite client --debug`
Expected: `endpoint : https://nyc.cloud.appwrite.io/v1`, `projectId : 6a0ad92e0001d5e515ce`, a non-empty `key`, and an **empty `cookie`** (no console session).

- [ ] **Verify (read probe):** `appwrite databases list` (if that subcommand errors on this CLI build, run `appwrite databases --help` and use the listed "list" command).
Expected: succeeds and returns the `Sample Finder DB` (`69217af50038b9005a61`). Success here proves the staging key authenticates against staging. **If this fails with 401, STOP** — the key or project is wrong; do not proceed.

### Task 3: Audit what already exists in staging 👤🤖

**Goal:** know exactly which of the 15 tables / 1 bucket / 3 functions are already present, so we only push what's missing and can see if a push changed anything.

- [ ] **Step 1 — Pull staging's current state into a scratch dir** (never the repo, so the committed config is untouched):

```bash
source "$HOME/.samplefinder-staging.env"
rm -rf /tmp/sf-staging-audit && mkdir -p /tmp/sf-staging-audit && cd /tmp/sf-staging-audit
appwrite client --endpoint "https://nyc.cloud.appwrite.io/v1" --project-id "6a0ad92e0001d5e515ce" --key "$APPWRITE_STAGING_API_KEY"
appwrite pull settings || true
appwrite pull tables || true
appwrite pull buckets || true
appwrite pull functions || true
ls -la /tmp/sf-staging-audit
```

- [ ] **Step 2 — 🤖 Claude diffs the pulled config against the committed prod config** and produces the gap list (tables/attributes/indexes/bucket/functions present vs missing). Paste the contents of `/tmp/sf-staging-audit/appwrite.config.json` (or say "it's empty").
- [ ] **Verify:** a written gap list exists, e.g. "staging has DB + N tables, missing: popups, popup_interactions, checkins; bucket missing; 0/3 functions." This drives Tasks 4–6.

### Task 4: Push schema (tables + attributes + indexes) 👤

**Goal:** all 15 tables present in staging with matching attributes/indexes/permissions.

- [ ] **Step 1 — Temporarily point the committed config at staging** (deterministic targeting; reverted at the end):

```bash
cd /Users/mirzakosimov/work/2026/samplefinder/samplefinder-admin/appwrite
cp appwrite.config.json appwrite.config.json.bak
sed -i '' 's/"projectId": "691d4a54003b21bf0136"/"projectId": "6a0ad92e0001d5e515ce"/' appwrite.config.json
grep '"projectId"' appwrite.config.json   # expect the STAGING id
```

- [ ] **Step 2 — Push tables:**

```bash
source "$HOME/.samplefinder-staging.env"
appwrite client --endpoint "https://nyc.cloud.appwrite.io/v1" --project-id "6a0ad92e0001d5e515ce" --key "$APPWRITE_STAGING_API_KEY"
appwrite push tables --force
```
Expected: each of the 15 tables reported created/updated; no auth errors.

- [ ] **Step 3 — Revert the config immediately** (so the repo keeps the prod id):

```bash
cd /Users/mirzakosimov/work/2026/samplefinder/samplefinder-admin/appwrite
mv appwrite.config.json.bak appwrite.config.json
grep '"projectId"' appwrite.config.json   # expect the PROD id 691d4a54... again
```

- [ ] **Verify:** re-run the Task 3 pull; confirm all 15 tables now exist in `/tmp/sf-staging-audit`. Spot-check that `popups`, `popup_interactions`, and `checkins` are present with their attributes.

### Task 5: Push storage bucket 👤

- [ ] **Step 1 — Repeat the transient-projectId edit** from Task 4 Step 1.
- [ ] **Step 2 — Push buckets:** `appwrite push buckets --force` → expect `files` (`6921b4ae002feef4b15e`) created/updated.
- [ ] **Step 3 — Revert the config** (Task 4 Step 3).
- [ ] **Verify:** `appwrite storage list-buckets` (or `appwrite storage --help` to find the exact subcommand) returns the `files` bucket with the expected id and file-security/permission settings matching prod.

### Task 6: Push + deploy functions 👤

- [ ] **Step 1 — Transient-projectId edit** (Task 4 Step 1).
- [ ] **Step 2 — Push functions** (deploys code for all 3): `appwrite push functions --force`. Expect Mobile API, Statistics functions, Notification functions each created and a deployment built. This can take several minutes per function.
- [ ] **Step 3 — Revert the config** (Task 4 Step 3).
- [ ] **Verify:** `appwrite functions list` shows all 3 with a **ready/active** deployment and scopes matching the config (e.g. Notification has schedule `*/15 * * * *`).

### Task 7: Set function environment variables 🖥️

**Goal:** functions actually run in staging (they read env vars not stored in the config). The `APPWRITE_FUNCTION_API_ENDPOINT` / `APPWRITE_FUNCTION_KEY` / `APPWRITE_FUNCTION_PROJECT_ID` trio is **auto-injected by the runtime — do NOT set those.**

For each function: Appwrite Console (staging project) → **Functions → \<function\> → Settings → Variables**. Set:

- [ ] **Mobile API** (`69308117000e7a96bcbb`):
  - `APPWRITE_API_KEY` = the staging server key (or a dedicated function key with the function's scopes)
  - `APPWRITE_NOTIFICATION_FUNCTION_ID` = `695d55bb002bc6b75430`
  - `TRIVIA_ONLY_TUESDAY_ET` = *(copy the exact value from the **prod** Mobile API function's Variables tab)*
- [ ] **Notification functions** (`695d55bb002bc6b75430`):
  - `APPWRITE_API_KEY` = staging server key
  - `APPWRITE_ENDPOINT` = `https://nyc.cloud.appwrite.io/v1`
  - `APPWRITE_PROJECT_ID` = `6a0ad92e0001d5e515ce`
  - `NOTIFICATION_APPEND_DEADLINE_MS` = *(copy from prod Notification function's Variables)*
  - `TZ` = *(copy from prod; expected `America/New_York`)*
- [ ] **Statistics functions** (`69341ffa001a4ebd28c2`):
  - `APPWRITE_API_KEY` = staging server key
- [ ] **Verify:** Console → Mobile API → **Execute** a test execution (or trigger via the admin later) and confirm a 2xx / non-error response; check the Notification function's next scheduled run logs after configuring Task 8.

### Task 8: Configure the staging push (FCM Messaging provider) 🖥️

**Goal:** the Notification function can deliver push (it uses Appwrite Messaging).

- [ ] **Step 1 — Get the FCM service account JSON** from the **existing** Firebase project (Firebase Console → Project settings → Service accounts → Generate new private key). This is the same Firebase project used by prod; no new project.
- [ ] **Step 2 — Create the provider:** Appwrite Console (staging) → **Messaging → Providers → Create provider → Push → FCM**. Name `fcm-staging`. Paste the service account JSON. Enable it.
- [ ] **Verify:** provider shows **enabled**; after the mobile staging build exists (Plan B) a test push to a registered target succeeds. For now, confirm the provider saves without validation error.

### Task 9: Configure staging auth 👤🖥️

**Goal:** email OTP / password reset / phone auth work for QA.

- [ ] **Step 1 — Push auth settings** (methods + session config from the config's `settings.auth`): transient-projectId edit (Task 4 Step 1) → `appwrite push settings --force` → revert (Task 4 Step 3).
- [ ] **Step 2 — SMTP** (email OTP + password recovery): Console (staging) → **Auth → Templates / Settings → SMTP** → configure a sender (reuse prod's SMTP credentials, or a test mailbox). Without this, email OTP and password reset silently fail.
- [ ] **Step 3 — Phone auth:** either configure an SMS provider (Console → Messaging → Providers → SMS), **or** for cheap QA add **mock phone numbers** (Console → Auth → Security → Mock numbers) so phone login works without real SMS.
- [ ] **Verify:** Console → Auth shows the enabled methods; sending a test OTP email succeeds (or a mock number logs in from the mobile build in Plan B).

### Task 10: Clone non-PII reference data 👤

**Goal:** staging has the same categories/locations/tiers/settings as prod (the app breaks without them).

- [ ] **Step 1 — Run the existing clone script** (reads prod with the read-only key, writes staging):

```bash
cd /Users/mirzakosimov/work/2026/samplefinder/samplefinder-admin
source "$HOME/.samplefinder-staging.env"
node scripts/clone-reference-data-to-staging.mjs
```
Expected: a summary table with `categories`, `locations`, `tiers`, `settings` rows created/updated, no errors.

- [ ] **Verify:** the script's summary shows non-zero reads for each collection and 0 failures; spot-check in the staging console that `categories` and `tiers` have rows.

### Task 11: Seed minimal test content 🖥️

- [ ] **Step 1 — Log into the admin dashboard against staging** (finish Task 15 first, or use the console) and create **one test event** (with a location) and **one test user profile** for QA.
- [ ] **Verify:** the event and user appear in the staging `events` / `user_profiles` tables.

---

## PHASE 2 — Admin dashboard

### Task 12: Refresh the staging env template 🤖

**Files:** Modify `samplefinder-admin/.env.staging.example`

**Goal:** the template matches the current prod var set (it predates `popups`/`checkins`).

- [ ] **Step 1 — Rewrite `.env.staging.example`** to mirror the current `.env.example` var list, with the staging project id and a header noting "identical to prod except VITE_APPWRITE_PROJECT_ID". Include: endpoint, project id (staging), project name, database id, all collection vars present in `.env.example` (`user_profiles`, `clients`, `events`, `trivia`, `reviews`, `checkins`, `reports`, `report_logs`, `notifications`, `categories`, `popups`), storage bucket id, the 3 function ids, and `VITE_ENABLE_TRIVIA_CUSTOM_SCHEDULE=false`.
- [ ] **Verify:** `diff <(grep -oE '^[A-Z_]+' .env.example | sort -u) <(grep -oE '^[A-Z_]+' .env.staging.example | sort -u)` prints no missing keys (staging example is a superset covering every `.env.example` key).

### Task 13: Create the real `.env.staging` 🤖👤

**Files:** Create `samplefinder-admin/.env.staging` (gitignored)

**Goal:** admin can run/build against staging. Contains **no secrets** (all `VITE_*` public values; admin uses session auth).

- [ ] **Step 1 — Confirm `.env.staging` is gitignored:** `git check-ignore .env.staging` → prints `.env.staging`. (If not, add it to `.gitignore`.)
- [ ] **Step 2 — 🤖 Write `.env.staging`** = the local prod `.env` values, changing only `VITE_APPWRITE_PROJECT_ID` to `6a0ad92e0001d5e515ce` and `VITE_APPWRITE_PROJECT_NAME` to `Samplefinder (Staging)`; add `VITE_APPWRITE_COLLECTION_CATEGORIES=categories` and `VITE_APPWRITE_COLLECTION_POPUPS=popups` if the app references them. All other ids (DB, bucket, functions, slugs) are identical to prod.
- [ ] **Verify:** `grep VITE_APPWRITE_PROJECT_ID .env.staging` shows the staging id; `git status` does **not** list `.env.staging` as untracked.

### Task 14: Verify the staging build compiles 🤖

- [ ] **Step 1 — Build against staging:**

```bash
cd /Users/mirzakosimov/work/2026/samplefinder/samplefinder-admin
npm run build:staging
```
Expected: `tsc -b` passes and `vite build --mode staging` completes with a `dist/` output, no errors.

- [ ] **Verify:** the build exits 0. (Optional: `grep -rl "6a0ad92e0001d5e515ce" dist/assets | head` confirms the staging project id was bundled.)

### Task 15: Runtime smoke test against staging 👤

- [ ] **Step 1 — Run the dev server against staging:** `npm run dev:staging`, open the local URL.
- [ ] **Step 2 — Log in** with a staging admin user (create one via the console/`label:admin-users` if needed), open **Events**, and confirm data loads from staging (not prod).
- [ ] **Step 3 — Do one write** (create/edit the Task 11 test event) and confirm it persists in the staging console.
- [ ] **Verify:** login + read + write all succeed against `6a0ad92e…`; network calls in devtools hit `nyc.cloud.appwrite.io` with the staging project header.

### Task 16: Commit admin changes 🤖

- [ ] **Step 1 — Commit** the template + any gitignore change (NOT `.env.staging`):

```bash
cd /Users/mirzakosimov/work/2026/samplefinder/samplefinder-admin
git add .env.staging.example .gitignore
git commit -m "chore(staging): refresh admin .env.staging template to match prod var set"
```

- [ ] **Verify:** `git status` clean except the intentionally-ignored `.env.staging`; `git log --oneline -1` shows the commit.

---

## Self-review notes

- **Spec coverage:** Phase 1 tasks map to spec §5.1–5.7 (schema→4, bucket→5, functions→6/7, push provider→8, auth→9, reference data→10, seed→11); Phase 2 tasks map to spec §6.1–6.4. Mobile (spec §7) is intentionally **Plan B**, written after this plan verifies the backend.
- **Prod-safety** is enforced structurally (staging-scoped key + console logout + transient-config revert), not by trusting `staging-cli.sh`'s unverified env override.
- **Known open item carried to execution:** exact CLI list/subcommand names on v14 may differ (e.g. `databases list` vs a tables variant); each such step says to run `appwrite <service> --help` and use the listed command. Consider `appwrite update` to a newer CLI **only** if v14 can't push the `tablesDB` format — decide during Task 4.
- **Not in this plan:** mobile app (Plan B), Vercel staging deploy, CI/CD.
