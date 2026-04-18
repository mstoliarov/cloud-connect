const { test } = require('node:test');
const assert = require('node:assert');
const { extractContextWindow } = require('../proxy.js');

test('extractContextWindow: OpenAI-style top_provider.context_length', () => {
    const modelsEntry = {
        id: 'nvidia/nemotron-super',
        context_length: 128000,
        top_provider: { context_length: 128000 },
    };
    assert.strictEqual(extractContextWindow(modelsEntry), 128000);
});

test('extractContextWindow: Ollama-style num_ctx in details', () => {
    const entry = { name: 'qwen3:8b', details: { num_ctx: 32768 } };
    assert.strictEqual(extractContextWindow(entry), 32768);
});

test('extractContextWindow: Ollama /api/show model_info.context_length', () => {
    const entry = { model_info: { 'qwen2.context_length': 32768 } };
    assert.strictEqual(extractContextWindow(entry), 32768);
});

test('extractContextWindow: missing returns null', () => {
    assert.strictEqual(extractContextWindow({}), null);
});
