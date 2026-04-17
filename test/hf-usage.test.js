const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeHfWhoami } = require('../proxy.js');

test('normalizeHfWhoami: free tier with usage', () => {
    const api = {
        name: 'testuser',
        type: 'user',
        isPro: false,
        periodEnd: 1744848000,
        inferenceProvidersUsage: { usageCents: 1234, limitCents: 10000 },
    };
    const usage = normalizeHfWhoami(api);
    assert.ok(usage.long);
    assert.strictEqual(usage.long.label, 'credits/mo');
    assert.strictEqual(usage.long.used, 1234);
    assert.strictEqual(usage.long.limit, 10000);
    assert.strictEqual(usage.long.pct, 12);
    assert.strictEqual(usage.long.resets_at, 1744848000);
});

test('normalizeHfWhoami: PRO tier fallback limit', () => {
    const api = { isPro: true, inferenceProvidersUsage: { usageCents: 50000 } };
    const usage = normalizeHfWhoami(api);
    assert.strictEqual(usage.long.limit, 200000);  // PRO $20 = 200000 cents
});

test('normalizeHfWhoami: missing usage → null', () => {
    const usage = normalizeHfWhoami({ name: 'x' });
    assert.strictEqual(usage.long, null);
});
