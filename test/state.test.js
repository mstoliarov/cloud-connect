const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { providerState, setProviderState, getProviderState, setLastProvider, getLastProvider } = require('../proxy.js');

beforeEach(() => {
    providerState.clear();
    setLastProvider(null);
});

test('setProviderState + getProviderState roundtrip', () => {
    setProviderState('groq', { model: 'llama-3', contextWindow: 8192 });
    const s = getProviderState('groq');
    assert.strictEqual(s.model, 'llama-3');
    assert.strictEqual(s.contextWindow, 8192);
    assert.ok(s.generated_at);
});

test('getProviderState: unknown returns null', () => {
    assert.strictEqual(getProviderState('nonexistent'), null);
});

test('setProviderState merges (does not overwrite)', () => {
    setProviderState('groq', { model: 'llama-3' });
    setProviderState('groq', { contextWindow: 8192 });
    const s = getProviderState('groq');
    assert.strictEqual(s.model, 'llama-3');
    assert.strictEqual(s.contextWindow, 8192);
});

test('setLastProvider / getLastProvider', () => {
    setLastProvider('openrouter');
    assert.strictEqual(getLastProvider(), 'openrouter');
});
