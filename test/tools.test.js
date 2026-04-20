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
