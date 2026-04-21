const { test } = require('node:test');
const assert = require('node:assert');
const {
    convertAnthropicToolsToOpenAI,
    convertToolChoice,
} = require('../proxy.js');

test('convertAnthropicToolsToOpenAI: basic schema', () => {
    const input = [{
        name: 'get_weather',
        description: 'Get current weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    }];
    const out = convertAnthropicToolsToOpenAI(input);
    assert.deepStrictEqual(out, [{
        type: 'function',
        function: {
            name: 'get_weather',
            description: 'Get current weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
    }]);
});

test('convertAnthropicToolsToOpenAI: empty/undefined → undefined', () => {
    assert.strictEqual(convertAnthropicToolsToOpenAI([]), undefined);
    assert.strictEqual(convertAnthropicToolsToOpenAI(undefined), undefined);
    assert.strictEqual(convertAnthropicToolsToOpenAI(null), undefined);
});

test('convertToolChoice: auto', () => {
    assert.strictEqual(convertToolChoice({ type: 'auto' }), 'auto');
});

test('convertToolChoice: any → required', () => {
    assert.strictEqual(convertToolChoice({ type: 'any' }), 'required');
});

test('convertToolChoice: specific tool', () => {
    assert.deepStrictEqual(
        convertToolChoice({ type: 'tool', name: 'get_weather' }),
        { type: 'function', function: { name: 'get_weather' } },
    );
});

test('convertToolChoice: none', () => {
    assert.strictEqual(convertToolChoice({ type: 'none' }), 'none');
});

test('convertToolChoice: undefined → undefined', () => {
    assert.strictEqual(convertToolChoice(undefined), undefined);
    assert.strictEqual(convertToolChoice(null), undefined);
});

const { convertMessages } = require('../proxy.js');

test('convertMessages: text-only user and assistant', () => {
    const input = [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
    ];
    assert.deepStrictEqual(convertMessages(input), [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
    ]);
});

test('convertMessages: assistant with tool_use only', () => {
    const input = [{
        role: 'assistant',
        content: [
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Moscow' } },
        ],
    }];
    assert.deepStrictEqual(convertMessages(input), [{
        role: 'assistant',
        content: null,
        tool_calls: [{
            id: 'toolu_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Moscow"}' },
        }],
    }]);
});

test('convertMessages: assistant with text + tool_use', () => {
    const input = [{
        role: 'assistant',
        content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Moscow' } },
        ],
    }];
    assert.deepStrictEqual(convertMessages(input), [{
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [{
            id: 'toolu_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Moscow"}' },
        }],
    }]);
});

test('convertMessages: user with tool_result (string content)', () => {
    const input = [{
        role: 'user',
        content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Sunny, 20°C' },
        ],
    }];
    assert.deepStrictEqual(convertMessages(input), [{
        role: 'tool',
        tool_call_id: 'toolu_1',
        content: 'Sunny, 20°C',
    }]);
});

test('convertMessages: user with tool_result (array of text blocks)', () => {
    const input = [{
        role: 'user',
        content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: [
                { type: 'text', text: 'Line 1' },
                { type: 'text', text: 'Line 2' },
            ]},
        ],
    }];
    assert.deepStrictEqual(convertMessages(input), [{
        role: 'tool',
        tool_call_id: 'toolu_1',
        content: 'Line 1Line 2',
    }]);
});

test('convertMessages: user with tool_result is_error=true → [error] prefix', () => {
    const input = [{
        role: 'user',
        content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'API failed', is_error: true },
        ],
    }];
    assert.deepStrictEqual(convertMessages(input), [{
        role: 'tool',
        tool_call_id: 'toolu_1',
        content: '[error] API failed',
    }]);
});

test('convertMessages: user with tool_result + text → tool msg first, then user text', () => {
    const input = [{
        role: 'user',
        content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Result A' },
            { type: 'text', text: 'What about B?' },
        ],
    }];
    assert.deepStrictEqual(convertMessages(input), [
        { role: 'tool', tool_call_id: 'toolu_1', content: 'Result A' },
        { role: 'user', content: 'What about B?' },
    ]);
});

test('convertMessages: multiple tool_results in one user message', () => {
    const input = [{
        role: 'user',
        content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'A' },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: 'B' },
        ],
    }];
    assert.deepStrictEqual(convertMessages(input), [
        { role: 'tool', tool_call_id: 'toolu_1', content: 'A' },
        { role: 'tool', tool_call_id: 'toolu_2', content: 'B' },
    ]);
});

test('convertMessages: nested object in tool_use.input serialized correctly', () => {
    const input = [{
        role: 'assistant',
        content: [
            { type: 'tool_use', id: 't1', name: 'fn', input: { nested: { a: 1, b: [2, 3] } } },
        ],
    }];
    const out = convertMessages(input);
    assert.strictEqual(out[0].tool_calls[0].function.arguments, '{"nested":{"a":1,"b":[2,3]}}');
});
