const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { extractGroqUsage, providerState } = require('../proxy.js');

beforeEach(() => providerState.clear());

test('extractGroqUsage: rpm + rpd from headers', () => {
    const headers = {
        'x-ratelimit-limit-requests': '30',
        'x-ratelimit-remaining-requests': '27',
        'x-ratelimit-reset-requests': '2s',
        'x-ratelimit-limit-tokens': '6000',
        'x-ratelimit-remaining-tokens': '5820',
        'x-ratelimit-reset-tokens': '1.8s',
    };
    const usage = extractGroqUsage(headers);
    assert.strictEqual(usage.short.label, 'rpm');
    assert.strictEqual(usage.short.used, 3);        // 30 - 27
    assert.strictEqual(usage.short.limit, 30);
    assert.strictEqual(usage.short.pct, 10);
});

test('extractGroqUsage: picks worst (max %) between rpm and tpm for short', () => {
    const headers = {
        'x-ratelimit-limit-requests': '30',
        'x-ratelimit-remaining-requests': '29',  // 3%
        'x-ratelimit-limit-tokens': '6000',
        'x-ratelimit-remaining-tokens': '3000',  // 50%
    };
    const usage = extractGroqUsage(headers);
    assert.strictEqual(usage.short.label, 'tpm');
    assert.strictEqual(usage.short.pct, 50);
});

test('extractGroqUsage: daily headers via x-ratelimit-limit-requests-day (when present)', () => {
    const headers = {
        'x-ratelimit-limit-requests': '30',
        'x-ratelimit-remaining-requests': '29',
        'x-ratelimit-limit-requests-day': '14400',
        'x-ratelimit-remaining-requests-day': '13900',
    };
    const usage = extractGroqUsage(headers);
    assert.ok(usage.long, 'long usage should be present');
    assert.strictEqual(usage.long.label, 'rpd');
    assert.strictEqual(usage.long.used, 500);
    assert.strictEqual(usage.long.limit, 14400);
});

test('extractGroqUsage: missing headers returns null usage fields', () => {
    const usage = extractGroqUsage({});
    assert.strictEqual(usage.short, null);
    assert.strictEqual(usage.long, null);
});
