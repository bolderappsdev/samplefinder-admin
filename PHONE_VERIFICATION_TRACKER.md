# SMS Phone Verification — Feature Tracker

> **Feeding this to a new session:** "Read `samplefinder-admin/PHONE_VERIFICATION_TRACKER.md`
> before starting." It is written to be enough context on its own.
>
> Spans **both** repos — `samplefinder-app` and `samplefinder-admin`.

| | |
|---|---|
| **Branch** | `feature/sms-phone-verification` (both repos, same name) |
| **Development** | ✅ **COMPLETE** — written, typechecked, committed, pushed |
| **Overall** | 🔴 **BLOCKED** on Twilio A2P campaign approval |
| **Blocker owner** | Legal / client — not an engineering task |
| **Flag** | `PHONE_VERIFICATION_ENABLED` — `true` in staging, **unset in prod** |
| **Last updated** | 2026-08-10 |

---

## 1. Where we are

All app and admin code is done and pushed. Real OTP delivery still fails, because
there is no approved US sending path: the A2P 10DLC campaign is `FAILED`. Nothing
in the codebase can fix that — see §3.

The feature is fully dormant in prod: the flag is unset there, and the
`phoneVerified` attribute does not exist in the prod Appwrite project yet.

Remaining work is **verification and rollout**, not development.

---

## 2. Development — ✅ COMPLETE

Everything below is implemented, typechecked (`npm run typecheck`, exit 0),
committed and pushed on `feature/sms-phone-verification`.

**Core verification flow**
- [x] Native Appwrite phone verification wired end to end — set phone, send code, verify
- [x] `phoneVerified` mirrored into `user_profiles` to drive routing
- [x] Cold-start routing gate — unverified users are returned to Verify Phone
- [x] Feature-flag dormancy, env-driven per environment
- [x] B1–B6 hardening — incl. Resend staying enabled after a failed first send, and a
      phone `409` no longer surfacing as an email-duplicate error

**A2P 10DLC compliance surface**
- [x] SMS consent checkbox at signup with program name, frequency, rate disclosure
      and HELP/STOP — enforced in `isFormValid` with a backstop in `handleSignUp`
- [x] Legal text sourced dynamically (Appwrite `settings` + live site), repo holds
      pointers only

**Mistyped-number recovery** (was an unrecoverable lockout)
- [x] Number shown unmasked on Verify Phone
- [x] "Wrong number? Change it" — correction modal, re-points the account, mirrors
      to the profile, re-sends, restarts the cooldown
- [x] Pre-signup confirmation modal showing the destination number in full

**Phone change from Edit Profile**
- [x] Changing the number re-points the Appwrite account and clears `phoneVerified`
- [x] Dedicated password prompt, decoupled from the Change Password fields — fixes a
      defect where changing the phone could change the password as a side effect
- [x] Signup onboarding no longer re-runs on re-verification (no repeat Tier 1 modal,
      welcome notification or referral application), including across a cold start
- [x] Re-verification returns to Profile rather than Home

**Admin + ops**
- [x] Read-only `phoneVerified` on the users list and edit modal
- [x] `check:twilio`, `check:legal`, guarded `appwrite-push`, `backfill:phone-verified`
- [x] `phoneVerified` attribute added to the **staging** Appwrite project

---

## 3. 🔴 The blocker — Twilio A2P 10DLC

Check current state any time: `npm run check:twilio` (add `--raw` to dump the campaign
JSON, which is how the rejection reason was found).

- **Brand:** `APPROVED`
- **Campaign:** `QE2c6890da8086d771620e9b13fadeba0b` — **`FAILED`**, use case 2FA
- **Messaging Service created:** 2026-06-23 22:47 UTC
- **Error:** `30908` (privacy policy), failing field **`MESSAGE_FLOW`**

**Root cause.** The live privacy policy is already adequate. The real problem is that
the **Terms and the Privacy Policy contradict each other** on how phone numbers are
used. Also relevant: privacy/terms URLs became **mandatory campaign fields on
30 June 2026**, a week *after* this campaign was created — so it predates the
requirement and was never given them.

**Live policy URLs (canonical):**
- https://samplefinder.com/terms-and-conditions/
- https://samplefinder.com/privacy-policy/

### Steps to unblock, in order

**Client handover document:** `legal/twilio-campaign-fix-guide.pdf` is a click-by-click
guide written for the client, covering both the website fix and the Twilio Console
resubmission. Source is `legal/twilio-campaign-fix-guide.html`; regenerate with
`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --no-pdf-header-footer --print-to-pdf=... file://...`

- [ ] **Legal publishes the Terms amendment** — draft at `legal/proposed-terms-sms-amendment.md`.
      **Blocking; nothing else proceeds.**
- [ ] Resubmit the campaign with both URLs populated and a rewritten `message_flow`
      describing the opt-in (checkbox at signup → one code per request)
- [ ] Wait for `VERIFIED`, then re-run `npm run check:twilio`
- [ ] Send a real test SMS from the Appwrite Console; confirm Twilio Message Log says `delivered`

Error codes to expect if something is still wrong: `30034` (10DLC unregistered),
`30032` (toll-free unverified), `21608` (trial account), `30007` (carrier filtered).

**Alternative if 10DLC drags:** toll-free verification is usually the faster route for
OTP. Costs more at volume. Not currently pursued.

---

## 4. Awaiting QA (staging)

Flag is on in staging. Code is complete; **none of this is human-verified yet.**

**Build to test against: staging `1.0.13 (87)`, cut 2026-08-10 from `8253869`.**
Android APK `SampleFinder-Staging-1.0.13-build87.apk` (99 MB, signed
`CN=SampleFinder, Polaris Brand Promotions`); iOS archive
`~/Library/Developer/Xcode/Archives/2026-08-10/SampleFinder-Staging-1.0.13-build87.xcarchive`.
Both passed the env gate (staging Appwrite id present, prod id absent), so
`PHONE_VERIFICATION_ENABLED=true` is inlined in both.

> ⚠️ **Check SMS delivery before assuming it works or doesn't.** Verified 2026-08-10 against the
> Twilio account in `samplefinder-admin/.env` (`ACcc70…c9a2`): the **message log is completely
> empty — zero messages ever sent**. So no OTP has ever been delivered as a text from that
> account, and a code seen during earlier testing most likely came from the Appwrite Console
> (Messaging → Messages records the body even when delivery fails), not from a handset.
>
> Two open questions, both answerable in the Appwrite Console in about a minute:
> 1. **Messaging → Providers** — which Twilio Account SID is configured, and is it enabled and
>    default? If it is *not* `ACcc70…c9a2`, then §3's campaign status is about the wrong account.
> 2. **Messaging → Messages** — do send attempts appear, and with what status/error?
>
> What is *not* in doubt: the only sender is a **US long code** (`+14845737822`) whose 10DLC
> campaign is `FAILED`, so **US** recipients will be filtered by US carriers (expect `30034`).
> A2P 10DLC is enforced by US carriers on US-terminating traffic only, so it does not by itself
> explain success or failure when testing with a non-US number.

- [ ] **Edit Profile → change phone.** Password prompt appears (no new-password field);
      wrong password errors inside the prompt and leaves the old number verified;
      duplicate number gives a clean message; success routes to Verify Phone
- [ ] **Verify Phone.** Number shows unmasked; "Wrong number? Change it" opens the
      correction modal; corrected number gets a fresh code and restarted cooldown
- [ ] **After verifying a changed number** → lands on Profile, **no Tier 1 modal**, no
      second "Welcome to SampleFinder!" notification
- [ ] **Kill the app** after Save but before entering the code, reopen → still no Tier 1
      modal on verify (this is the persisted-marker path)
- [ ] **Signup** (needs a sign-out) → consent checkbox required; confirmation modal shows
      the number in full before the account is created
- [ ] **Flag-off path** — set `PHONE_VERIFICATION_ENABLED=false`, confirm signup goes
      straight through with no confirmation modal. This is what prod runs today.

---

## 5. Not built (deliberate)

- [ ] **NANP validation at signup.** `(111) 111-1111` currently passes — only length is
      checked. Area code and exchange must not begin with 0 or 1. A regex is enough;
      `libphonenumber-js` is not installed.
- [ ] **Admin escape hatch** to clear a bad phone for a locked-out user. No one can be
      locked out today (flag off in prod), and the in-app correction flow makes it
      unnecessary going forward.

---

## 6. Prod rollout — not started

Do these in order, and only after the campaign is `VERIFIED`.

- [ ] Add the `phoneVerified` boolean attribute to the **prod** Appwrite project.
      Confirmed absent: prod has 33 attributes on `user_profiles`, staging has 34.
      **Use a surgical `create-boolean-attribute` call — see the warning in §8.**
- [ ] Run `npm run backfill:phone-verified` against prod
- [ ] Sync the legal text into the Appwrite `settings` table (`npm run check:legal --set/--from`)
- [ ] **Re-run the backfill immediately before flipping the flag** — any user created
      between the first backfill and the flip has no value set
- [ ] Set `PHONE_VERIFICATION_ENABLED=true` in the prod `.env`
- [ ] Verify in the Appwrite Console: Auth → Settings → Phone (SMS) enabled;
      Messaging → Providers → Twilio enabled + default; SMS template includes the brand name;
      Messaging → Settings → Geo Permissions → United States enabled

---

## 7. Known debt

- [ ] **`popups` and `popup_interactions` were destroyed in the staging Appwrite project.**
      Schema is recoverable from `origin/feature/SAM-5/popups`; **the rows are not** — no
      backups existed. Deferred by request until SMS is done.
- [ ] **No backup policy on either Appwrite project.** This is why the above was
      unrecoverable. Worth fixing before any further schema work.
- [x] ~~**`Release-Staging` iOS build crashes** — `TypeError: undefined is not a function at
      AppContainer`.~~ **No longer reproduces (2026-08-10).** Rebuilt `Release-Staging` at
      `8253869` and ran it on the iPhone 17 simulator: the app launches and renders the login
      screen, process stays alive, no crash report. Rendering that screen *is* `AppContainer`
      mounting, which is exactly what used to fail.
      **Likely cause of the original crash:** it was recorded before the Podfile
      `'Release-Staging' => :release` mapping was added and `pod-install` re-run — the
      `Pods-SampleFinder.release-staging.xcconfig` is dated 2026-08-10. The configuration is
      now sound. Ruled out along the way, each with evidence: env-key gaps (staging is a
      *superset* of prod, 21 vs 19 keys), build-setting divergence (only the 3 intended:
      `APP_DISPLAY_NAME`, entitlements, bundle id), a missing staging GoogleService plist or
      entitlements file, run-script ordering (it correctly runs after `Resources`), and RNFB's
      `Core Configuration` phase overwriting the swap (it only writes `Info.plist`).
- [ ] **`reactotron.ts` is untracked but imported by tracked code.** `App.tsx` has
      `import './reactotron'`, yet `reactotron.ts` is gitignored — **a fresh clone or CI
      checkout cannot build.** It survives locally only because the file exists on this
      machine. Found 2026-08-10 while investigating the crash above; not the cause of it.
- [ ] **Reactotron runs in release builds.** `reactotron.ts` calls
      `.configure().useReactNative().connect()` at module scope with **no `__DEV__` guard**,
      and `reactotron-react-native` is a **devDependency**. Every production bundle ships it
      and attempts a `localhost` socket connect on launch. Present since 2025-12-03 and prod
      has shipped with it, so it is not urgent — but it breaks the moment dev deps are pruned.
- [ ] **`.env` is tracked in the app repo** despite being in `.gitignore` (ignore rules do
      not apply to already-tracked files). It contradicts the CLAUDE.md rule that env files
      are not committed. Consider `git rm --cached .env`. The local copy currently has
      `PHONE_VERIFICATION_ENABLED=true` and was **deliberately not committed** — doing so
      would arm the gate in prod builds.

---

## 8. Facts a new session needs

**Appwrite phone verification (native, not custom)**
- `account.updatePhone({ phone, password })` — requires the password, and **resets
  `phoneVerification` to false**
- `account.createPhoneVerification()` — sends the SMS
- `account.updatePhoneVerification({ userId, secret })` — checks the code
- **OTP is valid for 15 minutes**
- Use the **object-based** SDK signatures. `react-native-appwrite@0.18.0` accepts
  positional ones too, but the project convention is object-based.
- **Account phone numbers are unique.** A duplicate throws `409`. This is why a mistyped
  number at signup used to lock that number away from its real owner.

**Feature flag**
- `src/constants/featureFlags.ts` reads `PHONE_VERIFICATION_ENABLED` via `@env`
  (react-native-dotenv). Anything but the string `"true"` disables it, including absent.
- **The SMS consent checkbox is intentionally NOT behind the flag** — A2P requires consent
  on record regardless.

**⚠️ Appwrite CLI push is destructive**
- `appwrite push tables` has **full-state semantics**: it deletes tables that exist
  remotely but not in local config. **`--id` does NOT scope it.** `--force` auto-confirms
  those deletions.
- This combination destroyed the staging popups tables. Use `scripts/appwrite-push.mjs`,
  which pre-flights and refuses, or make surgical single-attribute calls.
- The CLI resolves config from cwd. Endpoint is regional: `nyc.cloud.appwrite.io`, **not**
  the CLI default `cloud.appwrite.io`.

**iOS builds**
- There is **no `Debug-Staging` configuration**. The `SampleFinder-Staging` scheme maps to
  `Release-Staging`, which currently crashes (see §7).
- `expo run:ios` defaults to `--configuration Debug`, which **overrides the scheme** — that
  is how a "staging" build ends up with the prod bundle id `com.samplefinder.app`.
- Workaround used for testing: build **Debug** with `APP_VARIANT=staging` — staging Appwrite
  data plus Fast Refresh, but the prod bundle id.

**Staging test account:** `Tester`, profile row `6a795de40029f23c324b`, phone `(347) 824-5640`.

**Helper scripts** (run from `samplefinder-admin/`)
- `npm run check:twilio [--raw]` — sending-path readiness, names the blocker
- `npm run check:legal [--set|--from]` — read/write legal text in Appwrite `settings`
- `npm run backfill:phone-verified` — set `phoneVerified` on existing users
- `node scripts/appwrite-push.mjs` — guarded push

---

## 9. Decisions already made (do not relitigate)

- **Legal text is dynamic**, sourced from the Appwrite `settings` table and the live
  website. `src/constants/LegalContent.ts` is an **offline fallback with pointers only** —
  do not paste policy text back into the repo.
- **Never put a server Appwrite API key in the mobile client.** Session-based access only.
- **Password prompts stay separate from the password-change fields.** Confirming a phone
  change must not be able to authorise a password change.
- **`account.updatePhone` is always ordered before the profile write**, so a rejected change
  leaves the old verified number in place.
- **The Verify Phone number is shown unmasked** — spotting a typo is the point of that line,
  and it is the user's own number typed seconds earlier.
- **Secondary actions reuse existing app idioms** (the signup screen's "Have an account?
  Sign In" prompt-plus-action row). No bordered cards on auth screens.

---

## 10. Commit history on this branch

**`samplefinder-app`**
| Commit | What |
|---|---|
| `9a05a18` | B1–B6 hardening |
| `81638aa` | Env-driven flag, `changeAccountPhone`/`hasAccountPhone`, `phoneVerified` on profile updates, LegalContent reduced to pointers |
| `6aaa229` | SMS consent checkbox + pre-signup number confirmation modal |
| `f244c82` | Phone change from Edit Profile — password decoupling, no signup onboarding on re-verify |
| `8253869` | Verify Phone — unmasked number + correct a mistyped one |

**`samplefinder-admin`**
| Commit | What |
|---|---|
| `e7f3be8` | Read-only `phoneVerified` on the users list and edit modal |
| `1fa9534` | `check:twilio`, `check:legal`, guarded `appwrite-push` |
| `bc15df0` | Live policy URLs + drafted SMS terms amendment |

---

## 11. File map

**App** (`samplefinder-app/src/`)
- `constants/featureFlags.ts` — the flag
- `lib/auth.ts` — `signup`, `changeAccountPhone`, `hasAccountPhone`, `sendPhoneVerification`, `verifyPhone`
- `lib/phoneReverification.ts` — persisted "this is a re-verification, not a signup" marker
- `lib/signupOnboarding.ts` — one-time onboarding; **sets the Tier 1 modal**, must not run on re-verify
- `screens/auth/ConfirmPhoneScreen.tsx` + `useConfirmPhoneScreen.ts` — Verify Phone
- `screens/auth/SignUpScreen.tsx` + `useSignUpScreen.ts` + `signup/components/PhoneConfirmModal.tsx`
- `screens/tabs/EditProfileScreen.tsx` + `screens/tabs/profile/edit-profile/` — phone change + `PasswordPromptModal`
- `components/shared/ChangePhoneNumberModal.tsx` — correction modal on Verify Phone
- `navigation/AppNavigator.tsx` — the `phoneVerified` cold-start gate (~line 296, in `checkAuthSession`)

**Admin** (`samplefinder-admin/`)
- `appwrite/appwrite.config.json` — schema (⚠️ see the push warning in §8)
- `scripts/` — the helper scripts
- `legal/` — policy URLs and the draft amendment
