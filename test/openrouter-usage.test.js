const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const proxyModule = require('../proxy.js');
const { normalizeOpenRouterAuthKey, providerState } = proxyModule;

beforeEach(() => providerState.clear());

test('normalizeOpenRouterAuthKey maps rate_limit → usage.long', () => {
    const api = {
        data: {
            label: 'free',
            usage: 12.34,
            limit: null,
            rate_limit: { requests: 200, interval: '10s' },
            is_free_tier: true,
        },
    };
    const usage = normalizeOpenRouterAuthKey(api);
    assert.ok(usage.long);
    assert.strictEqual(usage.long.label, 'req/day');
    assert.strictEqual(usage.long.limit, 50);  // free tier default
});

test('normalizeOpenRouterAuthKey with credits ≥ 10 → 1000 rpd', () => {
    const api = {
        data: { label: 'paid', usage: 0, limit: 100, is_free_tier: false,
                rate_limit: { requests: 200, interval: '10s' } },
    };
    const usage = normalizeOpenRouterAuthKey(api);
    assert.strictEqual(usage.long.limit, 1000);
});
