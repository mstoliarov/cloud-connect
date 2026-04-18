const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeOllamaCloudPlan } = require('../proxy.js');

test('normalizeOllamaCloudPlan: free plan', () => {
    const api = { Plan: 'free', SubscriptionPeriodEnd: { Time: '0001-01-01T00:00:00Z', Valid: false } };
    const usage = normalizeOllamaCloudPlan(api);
    assert.strictEqual(usage.plan, 'free');
    assert.strictEqual(usage.long.label, 'weekly');
    assert.strictEqual(usage.long.pct, 0);
    assert.strictEqual(usage.short, null);
});

test('normalizeOllamaCloudPlan: pro plan with period end', () => {
    const api = { Plan: 'pro', SubscriptionPeriodEnd: { Time: '2026-05-01T00:00:00Z', Valid: true } };
    const usage = normalizeOllamaCloudPlan(api);
    assert.strictEqual(usage.plan, 'pro');
    assert.ok(usage.long.resets_at > 0, 'resets_at should be a unix timestamp');
});

test('normalizeOllamaCloudPlan: missing response returns null', () => {
    assert.strictEqual(normalizeOllamaCloudPlan(null), null);
    assert.strictEqual(normalizeOllamaCloudPlan({}), null);
});
