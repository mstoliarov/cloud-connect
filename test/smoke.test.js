const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { toOpenAI } = require('../proxy.js');

test('smoke: node native test runner works', () => {
    assert.strictEqual(1 + 1, 2);
});

test('smoke: toOpenAI produces well-formed body with tools', () => {
    const body = {
        model: 'groq-llama-3.3-70b-versatile',
        messages: [
            { role: 'user', content: 'Weather?' },
            { role: 'assistant', content: [
                { type: 'text', text: 'Checking' },
                { type: 'tool_use', id: 't1', name: 'get_weather', input: { city: 'Moscow' } },
            ]},
            { role: 'user', content: [
                { type: 'tool_result', tool_use_id: 't1', content: 'Sunny' },
            ]},
        ],
        tools: [{
            name: 'get_weather',
            description: 'Weather',
            input_schema: { type: 'object', properties: { city: { type: 'string' } } },
        }],
        tool_choice: { type: 'auto' },
        max_tokens: 100,
    };
    const out = toOpenAI(body, null);

    assert.strictEqual(out.model, 'groq-llama-3.3-70b-versatile');
    assert.strictEqual(out.messages.length, 3);
    assert.strictEqual(out.messages[0].role, 'user');
    assert.strictEqual(out.messages[1].role, 'assistant');
    assert.ok(Array.isArray(out.messages[1].tool_calls));
    assert.strictEqual(out.messages[2].role, 'tool');
    assert.strictEqual(out.messages[2].tool_call_id, 't1');
    assert.strictEqual(out.tools.length, 1);
    assert.strictEqual(out.tool_choice, 'auto');
    assert.strictEqual(out.max_tokens, 100);
});
