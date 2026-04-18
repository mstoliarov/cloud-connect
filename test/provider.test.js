const { test } = require('node:test');
const assert = require('node:assert');
const { resolveProvider, PROVIDER_META } = require('../proxy.js');

test('resolveProvider: claude- prefix → anthropic', () => {
    const p = resolveProvider('claude-sonnet-4-6');
    assert.strictEqual(p.id, 'anthropic');
    assert.strictEqual(p.icon, '🟠');
    assert.strictEqual(p.color, 'orange');
    assert.strictEqual(p.display, 'ant');
});

test('resolveProvider: or- prefix → openrouter', () => {
    const p = resolveProvider('or-nvidia/nemotron-3-super-120b-a12b:free');
    assert.strictEqual(p.id, 'openrouter');
    assert.strictEqual(p.icon, '🔵');
    assert.strictEqual(p.display, 'or');
});

test('resolveProvider: groq- prefix → groq', () => {
    const p = resolveProvider('groq-llama-3-70b');
    assert.strictEqual(p.id, 'groq');
    assert.strictEqual(p.icon, '🔴');
});

test('resolveProvider: hf- prefix → huggingface', () => {
    const p = resolveProvider('hf-meta-llama/Llama-3-8B');
    assert.strictEqual(p.id, 'huggingface');
    assert.strictEqual(p.icon, '🟡');
});

test('resolveProvider: no prefix → ollama (local)', () => {
    const p = resolveProvider('qwen3:8b');
    assert.strictEqual(p.id, 'ollama');
    assert.strictEqual(p.icon, '⚪');
    assert.strictEqual(p.display, 'oll');
});

test('resolveProvider: -cloud suffix → ollama-cloud', () => {
    const p = resolveProvider('qwen3-coder:480b-cloud');
    assert.strictEqual(p.id, 'ollama-cloud');
    assert.strictEqual(p.icon, '🔷');
    assert.strictEqual(p.color, 'cyan');
});

test('PROVIDER_META exports valid entries', () => {
    for (const [id, meta] of Object.entries(PROVIDER_META)) {
        assert.ok(meta.icon, `${id} needs icon`);
        assert.ok(meta.color, `${id} needs color`);
        assert.ok(meta.display, `${id} needs display`);
    }
});

test('resolveProvider: null → ollama fallback', () => {
    const p = resolveProvider(null);
    assert.strictEqual(p.id, 'ollama');
});

test('resolveProvider: undefined → ollama fallback', () => {
    const p = resolveProvider(undefined);
    assert.strictEqual(p.id, 'ollama');
});

test('resolveProvider: empty string → ollama fallback', () => {
    const p = resolveProvider('');
    assert.strictEqual(p.id, 'ollama');
});
