# Tool Use Support for HF/OR/Groq — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable tool use (function calling) in Claude CLI for HuggingFace, OpenRouter, and Groq providers, in both non-streaming and streaming modes.

**Architecture:** Extend `toOpenAI()`, `fromOpenAI()`, `streamOpenAIToAnthropic()`, and `mapStopReason()` in `proxy.js` in-place. Add pure helper functions exported for unit testing. No new files in source; add one new test file.

**Tech Stack:** Node.js, `node:test`, `node:assert`, `stream.PassThrough` for streaming tests.

**Spec:** `docs/superpowers/specs/2026-04-20-tool-use-providers-design.md`

---

## File Structure

- **Modify:** `proxy.js` — add helpers, extend conversion/streaming functions
- **Create:** `test/tools.test.js` — all tool-use unit tests
- **Modify:** `test/smoke.test.js` — add one end-to-end smoke test

---

## Task 1: Tool schema and tool_choice conversion

**Files:**
- Modify: `proxy.js` — add two helpers near line 490 (before `mapStopReason`); export at bottom
- Create: `test/tools.test.js`

- [ ] **Step 1: Write failing tests**

Create `test/tools.test.js` with:

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/tools.test.js`
Expected: all 6 tests fail with `TypeError: convertAnthropicToolsToOpenAI is not a function`.

- [ ] **Step 3: Implement helpers in `proxy.js`**

Add above `mapStopReason` (line ~491):

```javascript
function convertAnthropicToolsToOpenAI(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return undefined;
    return tools.map(t => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
        },
    }));
}

function convertToolChoice(choice) {
    if (!choice || typeof choice !== 'object') return undefined;
    if (choice.type === 'auto') return 'auto';
    if (choice.type === 'any') return 'required';
    if (choice.type === 'none') return 'none';
    if (choice.type === 'tool' && choice.name) {
        return { type: 'function', function: { name: choice.name } };
    }
    return undefined;
}
```

Add to `module.exports` at bottom (inside the existing object):

```javascript
    convertAnthropicToolsToOpenAI, convertToolChoice,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/tools.test.js`
Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add proxy.js test/tools.test.js
git commit -m "feat(tools): add tool schema and tool_choice converters"
```

---

## Task 2: Message conversion (tool_use / tool_result blocks)

**Files:**
- Modify: `proxy.js` — add `convertMessages` helper before `toOpenAI`, export
- Modify: `test/tools.test.js` — append tests

- [ ] **Step 1: Write failing tests**

Append to `test/tools.test.js`:

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/tools.test.js`
Expected: 9 new tests fail with `convertMessages is not a function`.

- [ ] **Step 3: Implement `convertMessages` in `proxy.js`**

Add above `toOpenAI` (around line 458):

```javascript
function extractTextFromToolResultContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('');
    }
    return String(content ?? '');
}

function convertMessages(messages) {
    const out = [];
    for (const msg of messages || []) {
        if (typeof msg.content === 'string') {
            out.push({ role: msg.role, content: msg.content });
            continue;
        }
        if (!Array.isArray(msg.content)) {
            out.push({ role: msg.role, content: String(msg.content ?? '') });
            continue;
        }

        if (msg.role === 'assistant') {
            const textParts = [];
            const toolCalls = [];
            for (const block of msg.content) {
                if (block.type === 'text') textParts.push(block.text);
                else if (block.type === 'tool_use') {
                    toolCalls.push({
                        id: block.id,
                        type: 'function',
                        function: {
                            name: block.name,
                            arguments: JSON.stringify(block.input ?? {}),
                        },
                    });
                }
            }
            const text = textParts.join('');
            const outMsg = { role: 'assistant', content: text || null };
            if (toolCalls.length > 0) outMsg.tool_calls = toolCalls;
            out.push(outMsg);
        } else if (msg.role === 'user') {
            const textParts = [];
            for (const block of msg.content) {
                if (block.type === 'tool_result') {
                    let content = extractTextFromToolResultContent(block.content);
                    if (block.is_error) content = '[error] ' + content;
                    out.push({
                        role: 'tool',
                        tool_call_id: block.tool_use_id,
                        content,
                    });
                } else if (block.type === 'text') {
                    textParts.push(block.text);
                }
            }
            const text = textParts.join('');
            if (text) out.push({ role: 'user', content: text });
        } else {
            // system or other — just join text blocks
            const text = msg.content
                .filter(b => b.type === 'text')
                .map(b => b.text)
                .join('');
            out.push({ role: msg.role, content: text });
        }
    }
    return out;
}
```

Add to `module.exports`:

```javascript
    convertMessages,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/tools.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add proxy.js test/tools.test.js
git commit -m "feat(tools): convert tool_use/tool_result blocks to OpenAI messages"
```

---

## Task 3: Integrate helpers into `toOpenAI`

**Files:**
- Modify: `proxy.js` — rewrite `toOpenAI` body to use `convertMessages`, `convertAnthropicToolsToOpenAI`, `convertToolChoice`
- Modify: `test/tools.test.js` — add integration tests

- [ ] **Step 1: Write failing integration tests**

Append to `test/tools.test.js`:

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/tools.test.js`
Expected: new tests fail — current `toOpenAI` uses `contentToString`, discards tool blocks.

- [ ] **Step 3: Rewrite `toOpenAI`**

Replace `proxy.js` lines 459–489 with:

```javascript
function toOpenAI(body, providerConfig) {
    const messages = [];

    if (body.system) {
        const sysText = typeof body.system === 'string'
            ? body.system
            : (Array.isArray(body.system)
                ? body.system.filter(b => b.type === 'text').map(b => b.text).join('\n')
                : String(body.system));
        messages.push({ role: 'system', content: sysText });
    }

    for (const m of convertMessages(body.messages || [])) {
        messages.push(m);
    }

    const out = { messages, model: body.model };
    if (body.max_tokens != null) {
        const cap = providerConfig?.maxTokens;
        out.max_tokens = cap ? Math.min(body.max_tokens, cap) : body.max_tokens;
    }
    if (body.temperature != null) out.temperature = body.temperature;
    if (body.top_p != null) out.top_p = body.top_p;
    if (body.stream != null) {
        out.stream = body.stream;
        if (body.stream) out.stream_options = { include_usage: true };
    }
    if (body.stop_sequences) out.stop = body.stop_sequences;

    const tools = convertAnthropicToolsToOpenAI(body.tools);
    if (tools) out.tools = tools;
    const toolChoice = convertToolChoice(body.tool_choice);
    if (toolChoice !== undefined) out.tool_choice = toolChoice;

    // thinking / betas are intentionally omitted — providers don't support them
    return out;
}
```

Add `toOpenAI` to `module.exports` if not already exported.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/tools.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add proxy.js test/tools.test.js
git commit -m "feat(tools): wire tool conversion into toOpenAI"
```

---

## Task 4: Non-streaming response conversion

**Files:**
- Modify: `proxy.js` — update `mapStopReason`, add `openAIChoiceToAnthropicContent`, rewrite `fromOpenAI`
- Modify: `test/tools.test.js` — add response tests

- [ ] **Step 1: Write failing tests**

Append to `test/tools.test.js`:

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/tools.test.js`
Expected: new tests fail — `openAIChoiceToAnthropicContent` not exported, current `fromOpenAI` returns text-only content and no tool_use mapping.

- [ ] **Step 3: Update `mapStopReason`**

Replace `proxy.js` lines 492–496 with:

```javascript
function mapStopReason(reason) {
    if (reason === 'stop') return 'end_turn';
    if (reason === 'length') return 'max_tokens';
    if (reason === 'tool_calls') return 'tool_use';
    return reason || 'end_turn';
}
```

- [ ] **Step 4: Add `openAIChoiceToAnthropicContent`**

Add above `fromOpenAI` (around line 498):

```javascript
function openAIChoiceToAnthropicContent(choice) {
    const blocks = [];
    const msg = choice?.message || {};
    const text = msg.content;
    if (typeof text === 'string' && text.length > 0) {
        blocks.push({ type: 'text', text });
    }
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    for (const tc of toolCalls) {
        const rawArgs = tc?.function?.arguments ?? '';
        let input;
        try {
            input = rawArgs ? JSON.parse(rawArgs) : {};
        } catch (e) {
            log(`[Warning] malformed tool arguments for ${tc?.function?.name}: ${rawArgs.slice(0, 100)}`);
            input = {};
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc?.function?.name, input });
    }
    return blocks;
}
```

- [ ] **Step 5: Rewrite `fromOpenAI`**

Replace lines 499–516 of `proxy.js` (adjust for current line numbers after previous edits) with:

```javascript
function fromOpenAI(body, originalModel) {
    const choice = (body.choices || [])[0] || {};
    const content = openAIChoiceToAnthropicContent(choice);
    if (content.length === 0) content.push({ type: 'text', text: '' });
    const usage = body.usage || {};
    return {
        id: body.id || `msg_proxy_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content,
        model: originalModel,
        stop_reason: mapStopReason(choice.finish_reason),
        stop_sequence: null,
        usage: {
            input_tokens: usage.prompt_tokens || 0,
            output_tokens: usage.completion_tokens || 0,
        },
    };
}
```

Add `openAIChoiceToAnthropicContent` and `fromOpenAI` to `module.exports`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/tools.test.js`
Expected: all tests pass. Also run full suite: `node --test` — no regressions.

- [ ] **Step 7: Commit**

```bash
git add proxy.js test/tools.test.js
git commit -m "feat(tools): convert OpenAI tool_calls to Anthropic tool_use (non-streaming)"
```

---

## Task 5: Streaming state machine

**Files:**
- Modify: `proxy.js` — rewrite `streamOpenAIToAnthropic` with tool-aware state
- Modify: `test/tools.test.js` — add streaming tests

- [ ] **Step 1: Write failing streaming tests**

Append to `test/tools.test.js`:

```javascript
const { PassThrough } = require('node:stream');
const { streamOpenAIToAnthropic } = require('../proxy.js');

// Helper: feed SSE chunks, return captured Anthropic events
function runStream(chunks) {
    return new Promise((resolve) => {
        const upstream = new PassThrough();
        const downstream = new PassThrough();
        const events = [];
        let buf = '';
        downstream.on('data', c => {
            buf += c.toString();
            const parts = buf.split('\n\n');
            buf = parts.pop();
            for (const p of parts) {
                const lines = p.split('\n');
                const evLine = lines.find(l => l.startsWith('event: '));
                const dataLine = lines.find(l => l.startsWith('data: '));
                if (evLine && dataLine) {
                    events.push({
                        event: evLine.slice(7).trim(),
                        data: JSON.parse(dataLine.slice(6).trim()),
                    });
                }
            }
        });
        downstream.on('end', () => resolve(events));
        streamOpenAIToAnthropic(upstream, downstream, 'test-model', 'msg_test');
        for (const c of chunks) upstream.write(c);
        upstream.end();
    });
}

function sseData(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }

test('stream: text-only', async () => {
    const chunks = [
        sseData({ choices: [{ delta: { content: 'Hel' } }] }),
        sseData({ choices: [{ delta: { content: 'lo' } }] }),
        sseData({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 1 } }),
        'data: [DONE]\n\n',
    ];
    const events = await runStream(chunks);
    const types = events.map(e => e.event);
    assert.deepStrictEqual(types, [
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
    ]);
    assert.strictEqual(events[1].data.content_block.type, 'text');
    assert.strictEqual(events[5].data.delta.stop_reason, 'end_turn');
});

test('stream: tool-only call', async () => {
    const chunks = [
        sseData({ choices: [{ delta: { tool_calls: [{
            index: 0, id: 'call_1', type: 'function',
            function: { name: 'get_weather', arguments: '' },
        }]}}]}),
        sseData({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] } }] }),
        sseData({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"Moscow"}' } }] } }] }),
        sseData({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        'data: [DONE]\n\n',
    ];
    const events = await runStream(chunks);
    const starts = events.filter(e => e.event === 'content_block_start');
    assert.strictEqual(starts.length, 1);
    assert.strictEqual(starts[0].data.content_block.type, 'tool_use');
    assert.strictEqual(starts[0].data.content_block.id, 'call_1');
    assert.strictEqual(starts[0].data.content_block.name, 'get_weather');

    const deltas = events.filter(e => e.event === 'content_block_delta');
    assert.strictEqual(deltas.length, 2);
    assert.strictEqual(deltas[0].data.delta.type, 'input_json_delta');
    assert.strictEqual(deltas[0].data.delta.partial_json, '{"city"');
    assert.strictEqual(deltas[1].data.delta.partial_json, ':"Moscow"}');

    const msgDelta = events.find(e => e.event === 'message_delta');
    assert.strictEqual(msgDelta.data.delta.stop_reason, 'tool_use');
});

test('stream: text then tool_call', async () => {
    const chunks = [
        sseData({ choices: [{ delta: { content: 'Checking...' } }] }),
        sseData({ choices: [{ delta: { tool_calls: [{
            index: 0, id: 'call_1', type: 'function',
            function: { name: 'fn', arguments: '{}' },
        }]}}]}),
        sseData({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        'data: [DONE]\n\n',
    ];
    const events = await runStream(chunks);
    const starts = events.filter(e => e.event === 'content_block_start');
    const stops = events.filter(e => e.event === 'content_block_stop');
    assert.strictEqual(starts.length, 2);
    assert.strictEqual(stops.length, 2);
    assert.strictEqual(starts[0].data.content_block.type, 'text');
    assert.strictEqual(starts[0].data.index, 0);
    assert.strictEqual(starts[1].data.content_block.type, 'tool_use');
    assert.strictEqual(starts[1].data.index, 1);
    assert.strictEqual(stops[0].data.index, 0);
    assert.strictEqual(stops[1].data.index, 1);
});

test('stream: two parallel tool_calls', async () => {
    const chunks = [
        sseData({ choices: [{ delta: { tool_calls: [{
            index: 0, id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' },
        }]}}]}),
        sseData({ choices: [{ delta: { tool_calls: [{
            index: 1, id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' },
        }]}}]}),
        sseData({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        'data: [DONE]\n\n',
    ];
    const events = await runStream(chunks);
    const starts = events.filter(e => e.event === 'content_block_start');
    assert.strictEqual(starts.length, 2);
    assert.strictEqual(starts[0].data.content_block.id, 'c1');
    assert.strictEqual(starts[0].data.index, 0);
    assert.strictEqual(starts[1].data.content_block.id, 'c2');
    assert.strictEqual(starts[1].data.index, 1);
});

test('stream: missing id on first tool_call chunk → fallback id generated', async () => {
    const chunks = [
        sseData({ choices: [{ delta: { tool_calls: [{
            index: 0, type: 'function', function: { name: 'fn', arguments: '{}' },
        }]}}]}),
        sseData({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        'data: [DONE]\n\n',
    ];
    const events = await runStream(chunks);
    const start = events.find(e => e.event === 'content_block_start');
    assert.match(start.data.content_block.id, /^toolu_proxy_/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/tools.test.js`
Expected: new tests fail — `streamOpenAIToAnthropic` not exported or doesn't emit tool blocks.

- [ ] **Step 3: Rewrite `streamOpenAIToAnthropic`**

Replace `proxy.js` lines 525–640 (current `streamOpenAIToAnthropic` body) with:

```javascript
function streamOpenAIToAnthropic(upstreamRes, res, originalModel, msgId) {
    let started = false;
    let outputTokens = 0;
    let inputTokens = 0;
    let stopReason = 'end_turn';
    let buf = '';
    let currentBlockIdx = -1;
    let textBlockIdx = -1;
    let nextBlockIdx = 0;
    const toolIndexMap = new Map();

    function ensureStarted(promptTokens) {
        if (started) return;
        started = true;
        inputTokens = promptTokens || 0;
        emitSSE(res, 'message_start', {
            type: 'message_start',
            message: {
                id: msgId, type: 'message', role: 'assistant',
                content: [], model: originalModel,
                stop_reason: null, stop_sequence: null,
                usage: { input_tokens: inputTokens, output_tokens: 0 },
            },
        });
    }

    function closeCurrentBlock() {
        if (currentBlockIdx === -1) return;
        emitSSE(res, 'content_block_stop', { type: 'content_block_stop', index: currentBlockIdx });
        currentBlockIdx = -1;
    }

    function openTextBlock() {
        if (textBlockIdx !== -1 && currentBlockIdx === textBlockIdx) return;
        closeCurrentBlock();
        if (textBlockIdx === -1) {
            textBlockIdx = nextBlockIdx++;
            emitSSE(res, 'content_block_start', {
                type: 'content_block_start',
                index: textBlockIdx,
                content_block: { type: 'text', text: '' },
            });
        }
        currentBlockIdx = textBlockIdx;
    }

    function openToolBlock(tc) {
        closeCurrentBlock();
        const anthropicIdx = nextBlockIdx++;
        const id = tc.id || `toolu_proxy_${Date.now()}_${anthropicIdx}`;
        if (!tc.id) log(`[Stream] tool_call missing id at index ${tc.index}, generated ${id}`);
        toolIndexMap.set(tc.index, { anthropicIdx, argsBuffer: '' });
        emitSSE(res, 'content_block_start', {
            type: 'content_block_start',
            index: anthropicIdx,
            content_block: {
                type: 'tool_use',
                id,
                name: tc.function?.name || 'unknown',
                input: {},
            },
        });
        currentBlockIdx = anthropicIdx;
        return toolIndexMap.get(tc.index);
    }

    upstreamRes.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const raw = trimmed.slice(5).trim();
            if (raw === '[DONE]') continue;

            let parsed;
            try { parsed = JSON.parse(raw); } catch (e) { continue; }

            const choice = (parsed.choices || [])[0];
            if (!choice) continue;

            ensureStarted(parsed.usage?.prompt_tokens);

            const delta = choice.delta || {};

            if (typeof delta.content === 'string' && delta.content.length > 0) {
                openTextBlock();
                emitSSE(res, 'content_block_delta', {
                    type: 'content_block_delta',
                    index: textBlockIdx,
                    delta: { type: 'text_delta', text: delta.content },
                });
            }

            if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                    if (typeof tc.index !== 'number') continue;
                    let entry = toolIndexMap.get(tc.index);
                    if (!entry) entry = openToolBlock(tc);
                    const args = tc.function?.arguments;
                    if (typeof args === 'string' && args.length > 0) {
                        entry.argsBuffer += args;
                        emitSSE(res, 'content_block_delta', {
                            type: 'content_block_delta',
                            index: entry.anthropicIdx,
                            delta: { type: 'input_json_delta', partial_json: args },
                        });
                    }
                }
            }

            if (choice.finish_reason) {
                stopReason = mapStopReason(choice.finish_reason);
                if (parsed.usage?.completion_tokens) outputTokens = parsed.usage.completion_tokens;
            }
        }
    });

    upstreamRes.on('end', () => {
        if (!started) {
            // Empty response — send a minimal valid Anthropic response
            ensureStarted(0);
            textBlockIdx = nextBlockIdx++;
            emitSSE(res, 'content_block_start', {
                type: 'content_block_start',
                index: textBlockIdx,
                content_block: { type: 'text', text: '' },
            });
            emitSSE(res, 'content_block_delta', {
                type: 'content_block_delta',
                index: textBlockIdx,
                delta: { type: 'text_delta', text: '(empty response from provider)' },
            });
            currentBlockIdx = textBlockIdx;
        }
        closeCurrentBlock();
        emitSSE(res, 'message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: outputTokens },
        });
        emitSSE(res, 'message_stop', { type: 'message_stop' });
        res.end();
    });

    upstreamRes.on('error', (err) => {
        log(`[Stream Error] ${err.message}`);
        if (res.writableEnded) return;
        try {
            ensureStarted(0);
            closeCurrentBlock();
            emitSSE(res, 'message_delta', {
                type: 'message_delta',
                delta: { stop_reason: 'error', stop_sequence: null },
                usage: { output_tokens: outputTokens },
            });
            emitSSE(res, 'message_stop', { type: 'message_stop' });
        } catch (e) { /* connection already broken */ }
        res.end();
    });
}
```

Add `streamOpenAIToAnthropic` to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/tools.test.js`
Expected: all streaming tests pass.

Then full suite: `node --test`
Expected: no regressions.

- [ ] **Step 5: Commit**

```bash
git add proxy.js test/tools.test.js
git commit -m "feat(tools): streaming state machine for tool_calls"
```

---

## Task 6: End-to-end smoke test

**Files:**
- Modify: `test/smoke.test.js` — add mock-server test

- [ ] **Step 1: Write failing smoke test**

Replace `test/smoke.test.js` with:

```javascript
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
```

- [ ] **Step 2: Run tests**

Run: `node --test test/smoke.test.js`
Expected: 2 tests pass.

Full suite: `node --test`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add test/smoke.test.js
git commit -m "test(tools): smoke test for end-to-end tool-enabled request"
```

---

## Final verification

- [ ] **Run full test suite**

```bash
cd /root/.claude-provider-proxy
node --test
```

Expected: all tests pass across all files.

- [ ] **Manual CLI verification** (optional, requires API key)

With a `GROQ_API_KEY` in `~/.claude-provider-proxy/proxy.env`:

1. Restart proxy: `systemctl --user restart cloud-connect` (or however it's managed)
2. In Claude CLI, set model to `groq-llama-3.3-70b-versatile`
3. Ask: "What files are in this directory?" — Claude should issue a tool call (Bash/LS), receive result, and respond.

Expected: tool use cycle completes without protocol errors.
