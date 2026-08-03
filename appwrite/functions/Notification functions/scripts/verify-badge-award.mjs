// Verifies that the ambassador / influencer badge points are awarded exactly ONCE per grant, by the
// server, and that a repeat call cannot pay twice. Run from this function's directory:
//   node scripts/verify-badge-award.mjs
// Imports the committed src/main.js (the file Appwrite executes), so this exercises shipped code.
//
// The bug being pinned: the mobile app used to add these 100 points itself whenever it saw the badge
// flag go disabled -> enabled, where "disabled" came from an AsyncStorage cache that returns false on
// any miss. A reinstall, cleared app storage, or a new device re-triggered the award, so a badged
// user's totalPoints climbed by 100 with no activity — repeatably. The award now lives here, on the
// path the admin panel calls exactly once per real transition.
//
// Exits non-zero on any failed assertion.

import { hasRecentBadgeAward, sendBadgeNotification } from '../src/main.js';

const DATABASE_ID = '69217af50038b9005a61';
const AWARD = 100;
const WINDOW_MS = 5 * 60 * 1000;

let failures = 0;
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`FAIL ${label}: expected ${e}, got ${a}`);
  } else {
    console.log(`ok   ${label}`);
  }
};

const noop = () => {};
const badgeNotification = (badgeType, createdAt) => ({
  id: `n-${badgeType}-${createdAt}`,
  type: 'badgeEarned',
  title: 'NEW BADGE',
  message: 'Congratulations!',
  isRead: false,
  createdAt,
  data: { badgeType, isSpecialBadge: 'true', pointsEarned: '100', screen: 'Profile' },
});

// --- hasRecentBadgeAward: the notifications field has FOUR shapes in the wild ------------------
// appendNotificationToUserProfile (this function) writes an array of JSON strings; the mobile app's
// createUserNotification also writes serialized entries; older rows may hold a single JSON string or
// raw objects. A shape this helper fails to parse silently reads as "never awarded" -> double pay.
const NOW = Date.parse('2026-08-03T12:00:00.000Z');
const recent = new Date(NOW - 60_000).toISOString();
const old = new Date(NOW - WINDOW_MS - 60_000).toISOString();

const shapes = {
  'array of objects': (n) => [n],
  'array of JSON strings': (n) => [JSON.stringify(n)],
  'JSON string of objects': (n) => JSON.stringify([n]),
  'JSON string of JSON strings': (n) => JSON.stringify([JSON.stringify(n)]),
};
for (const [name, wrap] of Object.entries(shapes)) {
  eq(`recent ambassador award detected — ${name}`,
    hasRecentBadgeAward({ notifications: wrap(badgeNotification('ambassador', recent)) }, 'ambassador', NOW),
    true);
  eq(`old ambassador award NOT recent — ${name}`,
    hasRecentBadgeAward({ notifications: wrap(badgeNotification('ambassador', old)) }, 'ambassador', NOW),
    false);
  eq(`other badge type does not block — ${name}`,
    hasRecentBadgeAward({ notifications: wrap(badgeNotification('influencer', recent)) }, 'ambassador', NOW),
    false);
}

// Degenerate inputs must read as "not awarded" (award proceeds) rather than throwing.
eq('missing notifications field', hasRecentBadgeAward({}, 'ambassador', NOW), false);
eq('null notifications', hasRecentBadgeAward({ notifications: null }, 'ambassador', NOW), false);
eq('empty string notifications', hasRecentBadgeAward({ notifications: '' }, 'ambassador', NOW), false);
eq('unparseable notifications string', hasRecentBadgeAward({ notifications: '{not json' }, 'ambassador', NOW), false);
eq('non-array JSON', hasRecentBadgeAward({ notifications: '{"a":1}' }, 'ambassador', NOW), false);
eq('entry with unparseable createdAt', hasRecentBadgeAward(
  { notifications: [badgeNotification('ambassador', 'not-a-date')] }, 'ambassador', NOW), false);
eq('non-badge notification ignored', hasRecentBadgeAward(
  { notifications: [{ type: 'Engagement', createdAt: recent, data: { badgeType: 'ambassador' } }] }, 'ambassador', NOW), false);
eq('badge notification with no data ignored', hasRecentBadgeAward(
  { notifications: [{ type: 'badgeEarned', createdAt: recent }] }, 'ambassador', NOW), false);

// --- sendBadgeNotification: end-to-end award behaviour ------------------------------------------
/**
 * Fake Appwrite Databases + Messaging. Records every write so we can assert on totalPoints.
 *
 * `flag` is the `badgePointsAwardedByServer` settings value. It defaults to 'true' here so the award
 * assertions below exercise the enabled path; the OFF/missing cases are asserted explicitly at the
 * end, because shipping inert is the whole point of the flag.
 */
const makeFakes = ({ startingPoints = 310, notifications = [], pushFails = false, pointsDriftOnReread = 0, flag = 'true' } = {}) => {
  const profile = {
    $id: 'profile-1',
    authID: 'auth-1',
    totalPoints: startingPoints,
    notifications,
  };
  const writes = [];
  let reads = 0;
  const databases = {
    async listDocuments(dbId, tableId, queries = []) {
      if (dbId !== DATABASE_ID) throw new Error(`unexpected database ${dbId}`);
      if (tableId === 'settings') {
        // getSettingValue(databases, key) -> Query.equal('key', key) + limit 1
        const wantsFlag = queries.some((q) => {
          const s = typeof q === 'string' ? q : JSON.stringify(q);
          return s.includes('badgePointsAwardedByServer');
        });
        if (!wantsFlag) return { documents: [], total: 0 };
        return flag === null
          ? { documents: [], total: 0 }
          : { documents: [{ $id: 's1', key: 'badgePointsAwardedByServer', value: flag }], total: 1 };
      }
      if (tableId !== 'user_profiles') throw new Error(`unexpected table ${tableId}`);
      return { documents: [{ ...profile }], total: 1 };
    },
    async getDocument(_dbId, _tableId, rowId) {
      if (rowId !== profile.$id) throw new Error(`unexpected row ${rowId}`);
      reads++;
      // Simulate another writer bumping points between the first read and the award.
      return { ...profile, totalPoints: profile.totalPoints + pointsDriftOnReread };
    },
    async updateDocument(_dbId, _tableId, rowId, data) {
      if (rowId !== profile.$id) throw new Error(`unexpected row ${rowId}`);
      writes.push(data);
      Object.assign(profile, data);
      return { ...profile };
    },
  };
  const messaging = {
    async createPush() {
      if (pushFails) throw new Error('simulated FCM failure');
      return { $id: 'msg-1', status: 'sent' };
    },
  };
  return { databases, messaging, profile, writes, getReads: () => reads };
};

const pointsWrites = (writes) => writes.filter((w) => w.totalPoints !== undefined);

// A genuine first grant pays exactly once.
{
  const f = makeFakes({ startingPoints: 310 });
  await sendBadgeNotification(f.databases, f.messaging, 'auth-1', 'ambassador', noop);
  eq('first grant: exactly one points write', pointsWrites(f.writes).length, 1);
  eq('first grant: totalPoints 310 -> 410', f.profile.totalPoints, 310 + AWARD);
}

// The same grant processed twice (double-submit / HTTP retry) must not pay twice. The first call's
// own notification is what the second call sees.
{
  const f = makeFakes({ startingPoints: 310 });
  await sendBadgeNotification(f.databases, f.messaging, 'auth-1', 'ambassador', noop);
  // Mimic appendNotificationToUserProfile having stored this grant's notification.
  f.profile.notifications = [JSON.stringify(badgeNotification('ambassador', new Date().toISOString()))];
  await sendBadgeNotification(f.databases, f.messaging, 'auth-1', 'ambassador', noop);
  eq('repeat call: still only one points write', pointsWrites(f.writes).length, 1);
  eq('repeat call: totalPoints stays 410 (no double-award)', f.profile.totalPoints, 310 + AWARD);
}

// This is the reinstall scenario that caused the bug. The old client re-added 100 on every cache
// miss; nothing on the server changes here, so the total must not move.
{
  const f = makeFakes({
    startingPoints: 410,
    notifications: [JSON.stringify(badgeNotification('ambassador', new Date().toISOString()))],
  });
  await sendBadgeNotification(f.databases, f.messaging, 'auth-1', 'ambassador', noop);
  eq('reinstall-style repeat within the window: no points write', pointsWrites(f.writes).length, 0);
  eq('reinstall-style repeat: totalPoints unchanged at 410', f.profile.totalPoints, 410);
}

// A legitimate re-grant later (badge removed, then granted again) SHOULD pay. The guard is a
// double-submit guard, not a permanent block.
// Uses a fixed long-past timestamp, not one derived from NOW: sendBadgeNotification reads the real
// clock, so a NOW-relative "old" value could land inside the live window and make this flaky.
{
  const LONG_AGO = '2025-01-01T00:00:00.000Z';
  const f = makeFakes({
    startingPoints: 410,
    notifications: [JSON.stringify(badgeNotification('ambassador', LONG_AGO))],
  });
  await sendBadgeNotification(f.databases, f.messaging, 'auth-1', 'ambassador', noop);
  eq('re-grant outside the window: pays again', f.profile.totalPoints, 410 + AWARD);
}

// The two badges are independent: holding one must not block the other.
{
  const f = makeFakes({
    startingPoints: 310,
    notifications: [JSON.stringify(badgeNotification('ambassador', new Date().toISOString()))],
  });
  await sendBadgeNotification(f.databases, f.messaging, 'auth-1', 'influencer', noop);
  eq('influencer grant not blocked by a recent ambassador award', f.profile.totalPoints, 310 + AWARD);
}

// Push failure: sendImmediateSystemNotificationToUser throws before storing the notification, so no
// points either. Matches the birthday/anniversary handlers, which skip the award when delivery fails.
{
  const f = makeFakes({ startingPoints: 310, pushFails: true });
  let threw = false;
  try {
    await sendBadgeNotification(f.databases, f.messaging, 'auth-1', 'ambassador', noop);
  } catch {
    threw = true;
  }
  eq('push failure propagates', threw, true);
  eq('push failure: no points awarded', pointsWrites(f.writes).length, 0);
  eq('push failure: totalPoints unchanged', f.profile.totalPoints, 310);
}

// The increment must be based on a FRESH read, not the profile fetched at the top — otherwise a
// concurrent check-in or trivia award made in between is silently clobbered.
{
  const f = makeFakes({ startingPoints: 310, pointsDriftOnReread: 50 });
  await sendBadgeNotification(f.databases, f.messaging, 'auth-1', 'ambassador', noop);
  eq('re-reads the profile before incrementing', f.getReads() >= 1, true);
  eq('concurrent +50 is preserved: 310+50+100 = 460', f.profile.totalPoints, 310 + 50 + AWARD);
}

// A failed points write must not fail the request — the badge and push already went out.
{
  const f = makeFakes({ startingPoints: 310 });
  f.databases.updateDocument = async () => {
    throw new Error('simulated write failure');
  };
  let threw = false;
  try {
    await sendBadgeNotification(f.databases, f.messaging, 'auth-1', 'ambassador', noop);
  } catch {
    threw = true;
  }
  eq('points-write failure is logged, not thrown', threw, false);
}

// --- the rollout flag --------------------------------------------------------------------------
// Default OFF matters: the mobile fix ships only via a store release (no OTA), so until old builds
// age out a client on the old code still pays. If this function paid at the same time, every grant
// would award 200. A missing setting must therefore behave exactly like today — notification sent,
// no points — and any deploy of the committed src/main.js must be inert.
{
  const f = makeFakes({ startingPoints: 310, flag: null });
  const r = await sendBadgeNotification(f.databases, f.messaging, 'auth-1', 'ambassador', noop);
  eq('flag missing: no points awarded', pointsWrites(f.writes).length, 0);
  eq('flag missing: totalPoints untouched', f.profile.totalPoints, 310);
  eq('flag missing: notification still delivered', r.sentCount, 1);
}
for (const off of ['false', '0', 'no', 'off', '', 'maybe']) {
  const f = makeFakes({ startingPoints: 310, flag: off });
  await sendBadgeNotification(f.databases, f.messaging, 'auth-1', 'ambassador', noop);
  eq(`flag "${off}": no points awarded`, f.profile.totalPoints, 310);
}
for (const on of ['true', 'TRUE', ' True ', '1', 'yes', 'on']) {
  const f = makeFakes({ startingPoints: 310, flag: on });
  await sendBadgeNotification(f.databases, f.messaging, 'auth-1', 'ambassador', noop);
  eq(`flag "${on}": points awarded`, f.profile.totalPoints, 310 + AWARD);
}

if (failures > 0) {
  console.error(`\n${failures} badge-award assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll badge-award assertions passed');
