'use strict';

// Reading /api/oauth/usage: when an account is out and until when.
const test = require('node:test');
const assert = require('node:assert/strict');
const { outStatus } = require('../src/core/usage');
const { HOUR } = require('./helpers');

test('limit info from the usage API', () => {
  const now = Date.now();
  const fetchedAt = now;
  const weekly = new Date(now + 50 * HOUR).toISOString();
  const st = outStatus(
    {
      fetchedAt,
      fiveHour: { pct: 30, resetsAt: now + HOUR },
      sevenDay: { pct: 100, resetsAt: Date.parse(weekly) },
      limits: [],
    },
    now,
  );
  assert.deepEqual(st, { out: true, until: Date.parse(weekly) });
  assert.deepEqual(outStatus({ fetchedAt, fiveHour: { pct: 100, resetsAt: now - 1 }, limits: [] }, now), { out: false });
});
