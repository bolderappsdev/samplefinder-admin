// Verifies sumUserTotalPoints paginates through ALL user_profiles instead of
// relying on Appwrite's default 25-row page (the bug that made Users-page
// "Avg. Points" show 1). Run from this function's directory:
//   node scripts/verify-avg-points.mjs
// Imports the committed src/main.js (the file Appwrite executes).
import { sumUserTotalPoints } from '../src/main.js';

const DEFAULT_PAGE_LIMIT = 25; // Appwrite's default when no Query.limit is sent

// 250 profiles: 240 x 100pts (signup bonus), 5 x 1000pts, 5 with null points.
const PROFILES = [
  ...Array.from({ length: 240 }, (_, i) => ({ $id: `u${i}`, totalPoints: 100 })),
  ...Array.from({ length: 5 }, (_, i) => ({ $id: `big${i}`, totalPoints: 1000 })),
  ...Array.from({ length: 5 }, (_, i) => ({ $id: `null${i}`, totalPoints: null })),
];
const EXPECTED_SUM = 240 * 100 + 5 * 1000; // 29000

// Minimal fake of Databases.listDocuments with real limit/cursorAfter semantics.
const fakeDatabases = {
  async listDocuments(_dbId, tableId, queries = []) {
    if (tableId !== 'user_profiles') {
      throw new Error(`Unexpected table queried: ${tableId}`);
    }
    let limit = DEFAULT_PAGE_LIMIT;
    let cursorAfter = null;
    for (const q of queries) {
      const parsed = typeof q === 'string' ? JSON.parse(q) : q;
      if (parsed.method === 'limit') limit = parsed.values[0];
      if (parsed.method === 'cursorAfter') cursorAfter = parsed.values[0];
    }
    let start = 0;
    if (cursorAfter) {
      const idx = PROFILES.findIndex((p) => p.$id === cursorAfter);
      if (idx === -1) throw new Error(`cursorAfter unknown id: ${cursorAfter}`);
      start = idx + 1;
    }
    return {
      total: PROFILES.length,
      documents: PROFILES.slice(start, start + limit),
    };
  },
};

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label} (expected ${expected}, got ${actual})`);
  if (!ok) failures++;
};

const sum = await sumUserTotalPoints(fakeDatabases);
check('sums totalPoints across every page, treating null as 0', sum, EXPECTED_SUM);
check('avg over 250 users', Math.round(sum / PROFILES.length), 116);

// Exact multiple of page size must not loop forever or drop rows.
const even = PROFILES.slice(0, 200);
const fakeEven = {
  async listDocuments(dbId, tableId, queries) {
    const res = await fakeDatabases.listDocuments(dbId, tableId, queries);
    const start = even.findIndex((p) => p.$id === res.documents[0]?.$id);
    return { total: even.length, documents: start === -1 ? [] : res.documents.filter((d) => even.some((p) => p.$id === d.$id)) };
  },
};
check('handles count that is an exact multiple of the page size', await sumUserTotalPoints(fakeEven), 200 * 100);

process.exit(failures ? 1 : 0);
