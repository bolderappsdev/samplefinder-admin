/**
 * Twilio readiness check for SMS phone verification — READ ONLY.
 *
 * Answers one question: can Appwrite actually deliver an OTP SMS to a real US
 * handset today? It only issues GET requests — it never provisions, registers,
 * sends, or changes anything in your Twilio account.
 *
 * It does not assume which sender you settled on. It discovers what exists
 * (long codes, toll-free numbers, Messaging Services, Brand/Campaign records)
 * and reports the readiness of whichever path you are actually on.
 *
 * Usage (from samplefinder-admin):
 *   TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... node scripts/check-twilio-readiness.mjs
 *
 * Or put them in samplefinder-admin/.env (gitignored) as:
 *   TWILIO_ACCOUNT_SID=AC...
 *   TWILIO_AUTH_TOKEN=...
 *
 * The auth token is never printed. Exit code 0 = no blockers, 1 = blockers.
 *
 * Endpoints used (verified against Twilio docs):
 *   GET /2010-04-01/Accounts/{Sid}.json                       account type/status
 *   GET /2010-04-01/Accounts/{Sid}/Balance.json               balance
 *   GET /2010-04-01/Accounts/{Sid}/IncomingPhoneNumbers.json  senders
 *   GET messaging/v1/Services                                 Messaging Services
 *   GET messaging/v1/a2p/BrandRegistrations                   A2P brand
 *   GET messaging/v1/Services/{Sid}/Compliance/Usa2p          A2P campaign
 *   GET messaging/v1/Tollfree/Verifications                   toll-free status
 */
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

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

if (!accountSid || !authToken) {
  console.error(`
Missing credentials.

  TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... node scripts/check-twilio-readiness.mjs

Both are on the Twilio Console home page (console.twilio.com) under "Account Info".
You can also add them to samplefinder-admin/.env, which is gitignored.
`);
  process.exit(1);
}

if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid)) {
  console.error(`TWILIO_ACCOUNT_SID does not look like an Account SID (expected "AC" + 32 hex chars).
If you are using an API Key (SK...), use the parent Account SID here instead.`);
  process.exit(1);
}

const AUTH = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** --raw dumps the full campaign object when the error list is empty or unclear. */
const RAW = process.argv.includes('--raw');

async function api(url) {
  const res = await fetch(url, { headers: { Authorization: AUTH, Accept: 'application/json' } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { message: text.slice(0, 200) };
  }
  if (!res.ok) {
    const err = new Error(body?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.twilioCode = body?.code;
    throw err;
  }
  return body;
}

// ── result collection ────────────────────────────────────────────────────────
const results = [];
const record = (label, state, detail) => {
  results.push({ label, state, detail });
  const mark = { PASS: '  OK  ', FAIL: ' FAIL ', WARN: ' WARN ', MANUAL: 'MANUAL', SKIP: ' SKIP ' }[state];
  console.log(`[${mark}] ${label.padEnd(26)} ${detail}`);
};

const TOLLFREE_PREFIXES = ['800', '833', '844', '855', '866', '877', '888'];
const isTollFree = (e164) => {
  const m = /^\+1(\d{3})/.exec(e164 || '');
  return m ? TOLLFREE_PREFIXES.includes(m[1]) : false;
};

console.log('\n══ TWILIO READINESS FOR SMS PHONE VERIFICATION ══');
console.log(`Account ${accountSid.slice(0, 6)}…${accountSid.slice(-4)}  (read-only checks)\n`);

let hasSmsSender = false;
let tollFreeNumbers = [];
let longCodeNumbers = [];
let services = [];

// ── 1. account type ──────────────────────────────────────────────────────────
try {
  const acct = await api(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`);
  const trial = acct.type !== 'Full';
  const inactive = acct.status !== 'active';
  if (trial) {
    record('Account type', 'FAIL', `${acct.type} — trial only sends to pre-verified numbers, and prepends a trial banner`);
  } else if (inactive) {
    record('Account type', 'FAIL', `Full but status is "${acct.status}"`);
  } else {
    record('Account type', 'PASS', `Full, active — "${acct.friendly_name}"`);
  }
} catch (e) {
  if (e.status === 401) {
    console.error('\nAuthentication failed (401). Check the Account SID / Auth Token pair.\n');
    process.exit(1);
  }
  record('Account type', 'FAIL', `could not read account: ${e.message}`);
}

// ── 2. balance ───────────────────────────────────────────────────────────────
try {
  const bal = await api(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Balance.json`);
  const amount = Number(bal.balance);
  record(
    'Balance',
    amount > 0 ? 'PASS' : 'WARN',
    `${bal.balance} ${bal.currency}${amount > 0 ? '' : ' — top up or enable auto-recharge'}`
  );
} catch (e) {
  record('Balance', 'WARN', `could not read balance: ${e.message}`);
}

// ── 3. SMS-capable senders ───────────────────────────────────────────────────
try {
  const nums = await api(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json?PageSize=100`
  );
  const list = nums.incoming_phone_numbers || [];
  const smsCapable = list.filter((n) => n.capabilities?.sms);
  tollFreeNumbers = smsCapable.filter((n) => isTollFree(n.phone_number));
  longCodeNumbers = smsCapable.filter((n) => !isTollFree(n.phone_number));
  hasSmsSender = smsCapable.length > 0;

  if (!hasSmsSender) {
    record('SMS senders', 'FAIL', `${list.length} number(s), none SMS-capable — buy an SMS-capable US number`);
  } else {
    record(
      'SMS senders',
      'PASS',
      `${smsCapable.length} SMS-capable (${longCodeNumbers.length} long code, ${tollFreeNumbers.length} toll-free)`
    );
    for (const n of smsCapable) {
      console.log(`           ${n.phone_number}  ${isTollFree(n.phone_number) ? 'toll-free' : 'long code'}`);
    }
  }
} catch (e) {
  record('SMS senders', 'FAIL', `could not list numbers: ${e.message}`);
}

// ── 4. messaging services ────────────────────────────────────────────────────
try {
  const svc = await api('https://messaging.twilio.com/v1/Services?PageSize=50');
  services = svc.services || [];
  if (services.length === 0) {
    record('Messaging Service', 'WARN', 'none — Appwrite can use a bare number, but an MG service is recommended');
  } else {
    record('Messaging Service', 'PASS', `${services.length} found`);
    for (const s of services) console.log(`           ${s.sid}  "${s.friendly_name}"`);
  }
} catch (e) {
  record('Messaging Service', 'WARN', `could not list services: ${e.message}`);
}

// ── 5. A2P brand (10DLC path) ────────────────────────────────────────────────
let brandApproved = false;
let brandSeen = false;
try {
  const brands = await api('https://messaging.twilio.com/v1/a2p/BrandRegistrations?PageSize=50');
  const list = brands.data || brands.brand_registrations || [];
  brandSeen = list.length > 0;
  if (!brandSeen) {
    record('A2P Brand (10DLC)', longCodeNumbers.length ? 'FAIL' : 'SKIP',
      longCodeNumbers.length
        ? 'no brand registered — long-code US traffic will be blocked (error 30034)'
        : 'none registered (only needed for the long-code path)');
  } else {
    const best = list.find((b) => b.status === 'APPROVED') || list[0];
    brandApproved = best.status === 'APPROVED';
    record(
      'A2P Brand (10DLC)',
      brandApproved ? 'PASS' : ['PENDING', 'IN_REVIEW'].includes(best.status) ? 'WARN' : 'FAIL',
      `${best.status}${best.failure_reason ? ` — ${best.failure_reason}` : ''}`
    );
  }
} catch (e) {
  record('A2P Brand (10DLC)', 'WARN', `could not read brand registrations: ${e.message}`);
}

// ── 6. A2P campaign, per messaging service ───────────────────────────────────
// Twilio rate-limits campaign reads to roughly 1 request / 5 s.
let campaignVerified = false;
if (services.length === 0) {
  record('A2P Campaign', 'SKIP', 'no Messaging Service to inspect');
} else {
  const toCheck = services.slice(0, 5);
  if (services.length > toCheck.length) {
    console.log(`           (checking first ${toCheck.length} of ${services.length} services)`);
  }
  for (let i = 0; i < toCheck.length; i++) {
    const s = toCheck[i];
    if (i > 0) await sleep(5200); // respect the documented rate limit
    try {
      const camp = await api(`https://messaging.twilio.com/v1/Services/${s.sid}/Compliance/Usa2p`);
      const list = camp.compliance || camp.data || [];
      if (list.length === 0) {
        record(`A2P Campaign`, longCodeNumbers.length ? 'FAIL' : 'SKIP',
          `${s.friendly_name}: no campaign${longCodeNumbers.length ? ' — required for long-code US traffic' : ''}`);
        continue;
      }
      for (const c of list) {
        const ok = c.campaign_status === 'VERIFIED';
        if (ok) campaignVerified = true;
        record(
          'A2P Campaign',
          ok ? 'PASS' : c.campaign_status === 'FAILED' ? 'FAIL' : 'WARN',
          `${s.friendly_name}: ${c.campaign_status}` +
            `${c.us_app_to_person_usecase ? ` (${c.us_app_to_person_usecase})` : ''}` +
            `${c.sid ? `  ${c.sid}` : ''}`
        );

        // The rejection detail lives in `errors` — this is the part that tells
        // you what to actually change before resubmitting.
        const errs = Array.isArray(c.errors) ? c.errors : [];
        for (const err of errs) {
          const code = err.error_code ?? err.code ?? '?';
          const desc = err.description || err.message || JSON.stringify(err);
          console.log(`           ↳ [${code}] ${desc}`);
          if (Array.isArray(err.fields) && err.fields.length) {
            console.log(`             fields: ${err.fields.join(', ')}`);
          }
          if (err.url) console.log(`             ${err.url}`);
          if (code !== '?') console.log(`             https://www.twilio.com/docs/api/errors/${code}`);
        }
        if (c.campaign_status === 'FAILED' && errs.length === 0) {
          console.log('           ↳ no error detail in the response — re-run with --raw to dump the campaign object');
        }
        if (RAW) console.log(JSON.stringify(c, null, 2));
      }
    } catch (e) {
      record('A2P Campaign', 'WARN', `${s.friendly_name}: ${e.message}`);
    }
  }
}

// ── 7. toll-free verification ────────────────────────────────────────────────
let tollFreeApproved = false;
try {
  const tf = await api('https://messaging.twilio.com/v1/Tollfree/Verifications?PageSize=50');
  const list = tf.verifications || tf.data || [];
  if (list.length === 0) {
    record('Toll-free verification', tollFreeNumbers.length ? 'FAIL' : 'SKIP',
      tollFreeNumbers.length
        ? 'you own toll-free numbers but none are verified — traffic will be blocked (error 30032)'
        : 'none (only needed for the toll-free path)');
  } else {
    for (const v of list) {
      const ok = v.status === 'TWILIO_APPROVED';
      if (ok) tollFreeApproved = true;
      record(
        'Toll-free verification',
        ok ? 'PASS' : v.status === 'TWILIO_REJECTED' ? 'FAIL' : 'WARN',
        `${v.status}${v.rejection_reason ? ` — ${v.rejection_reason}` : ''}`
      );
    }
  }
} catch (e) {
  record('Toll-free verification', 'WARN', `could not read verifications: ${e.message}`);
}

// ── 8-9. things the API does not expose ──────────────────────────────────────
record('Geo permissions', 'MANUAL', 'Console → Messaging → Settings → Geo Permissions: United States enabled');
record('Appwrite provider', 'MANUAL', 'Appwrite Console → Messaging → Providers: Twilio added, enabled, default');

// ── verdict ──────────────────────────────────────────────────────────────────
const fails = results.filter((r) => r.state === 'FAIL');
const warns = results.filter((r) => r.state === 'WARN');
const deliverable = (brandApproved && campaignVerified) || tollFreeApproved;

console.log('\n── VERDICT ' + '─'.repeat(52));

if (fails.length === 0 && deliverable) {
  console.log('READY to smoke-test. No blockers found on an approved sending path.');
} else if (deliverable) {
  console.log('LIKELY READY — an approved sending path exists, but some checks need attention.');
} else {
  console.log('NOT READY — no approved US sending path yet. Real OTP delivery will fail.');
}

if (fails.length) {
  console.log(`\nBlockers (${fails.length}):`);
  fails.forEach((f) => console.log(`  • ${f.label}: ${f.detail}`));
}
if (warns.length) {
  console.log(`\nWarnings (${warns.length}):`);
  warns.forEach((w) => console.log(`  • ${w.label}: ${w.detail}`));
}

if (!deliverable) {
  console.log('\nSending path not yet established. The two options:');
  console.log('  Toll-free  — Toll-Free Verification only. Usually the fastest route for OTP.');
  console.log('  10DLC      — Brand + Campaign registration. Better ongoing cost at volume.');
}

console.log('\nManual checks the API cannot cover:');
console.log('  • Geo Permissions: Console → Messaging → Settings → Geo Permissions → United States');
console.log('  • SMS template:    Appwrite Console → Auth → Templates → SMS (include your brand name)');
console.log('  • Provider wiring: Appwrite Console → Messaging → Providers → Twilio (enabled + default)');
console.log('  • Phone auth:      Appwrite Console → Auth → Settings → Phone (SMS) enabled');
console.log('\nAfter this passes, send a real test SMS from the Appwrite Console and confirm the');
console.log('Twilio Message Log shows "delivered". Watch for 30034 (10DLC unregistered),');
console.log('30032 (toll-free unverified), 21608 (trial), 30007 (carrier filtered).\n');

process.exit(fails.length === 0 && deliverable ? 0 : 1);
