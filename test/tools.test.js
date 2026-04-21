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

const { toOpenAI } = require('../proxy.js');

test('toOpenAI: passes tools array', () => {
    const body = {
        model: 'groq-llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: 'Weather in Moscow?' }],
        tools: [{
            name: 'get_weather',
            description: 'Get weather',
            input_schema: { type: 'object', properties: { city: { type: 'string' } } },
        }],
    };
    const out = toOpenAI(body, null);
    assert.strictEqual(out.tools.length, 1);
    assert.strictEqual(out.tools[0].type, 'function');
    assert.strictEqual(out.tools[0].function.name, 'get_weather');
});

test('toOpenAI: passes tool_choice', () => {
    const body = {
        model: 'm',
        messages: [{ role: 'user', content: 'go' }],
        tool_choice: { type: 'any' },
    };
    const out = toOpenAI(body, null);
    assert.strictEqual(out.tool_choice, 'required');
});

test('toOpenAI: omits tools when empty', () => {
    const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] };
    const out = toOpenAI(body, null);
    assert.strictEqual('tools' in out, false);
});

test('toOpenAI: assistant tool_use blocks become tool_calls', () => {
    const body = {
        model: 'm',
        messages: [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: [
                { type: 'tool_use', id: 't1', name: 'fn', input: { x: 1 } },
            ]},
            { role: 'user', content: [
                { type: 'tool_result', tool_use_id: 't1', content: 'done' },
            ]},
        ],
    };
    const out = toOpenAI(body, null);
    assert.strictEqual(out.messages.length, 3);
    assert.strictEqual(out.messages[1].role, 'assistant');
    assert.strictEqual(out.messages[1].tool_calls[0].id, 't1');
    assert.strictEqual(out.messages[2].role, 'tool');
    assert.strictEqual(out.messages[2].tool_call_id, 't1');
});

test('toOpenAI: system prompt still included', () => {
    const body = {
        model: 'm',
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'hi' }],
    };
    const out = toOpenAI(body, null);
    assert.strictEqual(out.messages[0].role, 'system');
    assert.strictEqual(out.messages[0].content, 'You are helpful.');
});

const { openAIChoiceToAnthropicContent, fromOpenAI } = require('../proxy.js');

test('openAIChoiceToAnthropicContent: text-only', () => {
    const choice = { message: { content: 'hello', tool_calls: undefined } };
    const blocks = openAIChoiceToAnthropicContent(choice);
    assert.deepStrictEqual(blocks, [{ type: 'text', text: 'hello' }]);
});

test('openAIChoiceToAnthropicContent: tool_calls only', () => {
    const choice = { message: {
        content: null,
        tool_calls: [{ id: 'c1', function: { name: 'fn', arguments: '{"x":1}' } }],
    }};
    const blocks = openAIChoiceToAnthropicContent(choice);
    assert.deepStrictEqual(blocks, [{ type: 'tool_use', id: 'c1', name: 'fn', input: { x: 1 } }]);
});

test('openAIChoiceToAnthropicContent: text + tool_calls', () => {
    const choice = { message: {
        content: 'looking up',
        tool_calls: [{ id: 'c1', function: { name: 'fn', arguments: '{}' } }],
    }};
    const blocks = openAIChoiceToAnthropicContent(choice);
    assert.deepStrictEqual(blocks, [
        { type: 'text', text: 'looking up' },
        { type: 'tool_use', id: 'c1', name: 'fn', input: {} },
    ]);
});

test('openAIChoiceToAnthropicContent: malformed arguments → empty input', () => {
    const choice = { message: {
        content: null,
        tool_calls: [{ id: 'c1', function: { name: 'fn', arguments: 'not json' } }],
    }};
    const blocks = openAIChoiceToAnthropicContent(choice);
    assert.deepStrictEqual(blocks, [{ type: 'tool_use', id: 'c1', name: 'fn', input: {} }]);
});

test('fromOpenAI: tool_calls → stop_reason tool_use', () => {
    const body = {
        id: 'x',
        choices: [{
            message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'fn', arguments: '{}' } }] },
            finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const out = fromOpenAI(body, 'groq-x');
    assert.strictEqual(out.stop_reason, 'tool_use');
    assert.strictEqual(out.content.length, 1);
    assert.strictEqual(out.content[0].type, 'tool_use');
    assert.strictEqual(out.content[0].id, 'c1');
});

test('fromOpenAI: plain text response unchanged', () => {
    const body = {
        id: 'x',
        choices: [{ message: { content: 'hi', tool_calls: undefined }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
    const out = fromOpenAI(body, 'm');
    assert.strictEqual(out.stop_reason, 'end_turn');
    assert.deepStrictEqual(out.content, [{ type: 'text', text: 'hi' }]);
});
