# Tool Use Support for HuggingFace, OpenRouter, Groq Providers

**Date:** 2026-04-20
**Status:** Design

## Context

Currently `proxy.js` supports tool use only for Anthropic (full passthrough) and Ollama (Anthropic-native passthrough). Requests routed to HuggingFace, OpenRouter, and Groq go through `toOpenAI()` / `fromOpenAI()` conversion, which discards `tools`, `tool_use` blocks, and `tool_result` blocks entirely — `contentToString()` keeps only text.

Goal: enable tool use in Claude CLI for all three OpenAI-compatible providers, including streaming.

## Scope

- In scope: bidirectional conversion of `tools`, `tool_use`, `tool_result`, `tool_choice`, `stop_reason` between Anthropic and OpenAI formats, for both non-streaming and streaming.
- Out of scope: vision / image tool_result blocks (log and skip), HF-specific parser-less routes, tool_use for Anthropic/Ollama paths (already working).

## Architecture

Extend in-place in `proxy.js`. No new files.

| Function | Lines (current) | Change |
|---|---|---|
| `contentToString()` | 450–456 | Replaced with richer helpers; kept for backwards compat if needed |
| `toOpenAI()` | 459–489 | + `tools[]`, `tool_choice`, tool_use/tool_result blocks via new `convertMessages()` |
| `mapStopReason()` | 492–496 | + `"tool_calls"` → `"tool_use"` |
| `fromOpenAI()` | 499–516 | + emit `tool_use` blocks from `tool_calls` |
| `streamOpenAIToAnthropic()` | 525–640 | + state machine for tool_call deltas, block indexing |

New helpers (exported for tests):
- `convertAnthropicToolsToOpenAI(tools)`
- `convertToolChoice(choice)`
- `convertMessages(messages)` — splits tool_result into separate `role:"tool"` messages
- `openAIChoiceToAnthropicContent(choice)` — non-streaming response conversion

## Conversion Rules

### Request: Anthropic → OpenAI

**tools[]:**
```
{name, description, input_schema}
  → {type:"function", function:{name, description, parameters: input_schema}}
```
Empty array → `tools` field omitted from OpenAI body.

**tool_choice:**
| Anthropic | OpenAI |
|---|---|
| `{type:"auto"}` | `"auto"` |
| `{type:"any"}` | `"required"` |
| `{type:"tool", name:"X"}` | `{type:"function", function:{name:"X"}}` |
| `{type:"none"}` | `"none"` |

**Messages:**

Assistant message with `text` + `tool_use` blocks:
```json
{role:"assistant", content:"<concatenated text>", tool_calls:[
  {id:<tool_use.id>, type:"function",
   function:{name:<tool_use.name>, arguments: JSON.stringify(tool_use.input)}}
]}
```
If no text: `content: null`.

User message with `text` + `tool_result` blocks:
- Each `tool_result` becomes a separate `{role:"tool", tool_call_id, content}` message.
- Emit all tool messages first (in appearance order), then user text message.
- `tool_result.content` string → direct content; array of blocks → extract text blocks, join, skip image blocks with log warning.
- `tool_result.is_error:true` → prefix content with `"[error] "`.

### Response: OpenAI → Anthropic (non-streaming)

OpenAI `choice.message` with `content` and/or `tool_calls`:
```json
{content:"...", tool_calls:[{id, function:{name, arguments}}]}
```
→ Anthropic `content[]`:
```json
[
  {type:"text", text:"..."},                          // only if content non-empty
  {type:"tool_use", id, name, input: JSON.parse(arguments)}
]
```

- `finish_reason:"tool_calls"` → `stop_reason:"tool_use"`.
- Malformed JSON in `arguments` → fallback `input:{}`, log `[Warning] malformed tool arguments`, do not throw.

### IDs

Pass OpenAI `tool_call.id` through as Anthropic `tool_use.id` unchanged. Claude CLI uses opaque strings.

## Streaming State Machine

### OpenAI delta format
- `delta.content` — text chunks (may be empty string or absent)
- `delta.tool_calls[]` — array with `tc.index` (position), `tc.id` and `tc.function.name` only on first chunk, `tc.function.arguments` as incremental JSON string pieces

### State in `streamOpenAIToAnthropic`

```js
let started = false;
let outputTokens = 0;
let stopReason = 'end_turn';
let currentBlockIdx = -1;       // currently open Anthropic block (-1 = none)
let textBlockIdx = -1;          // index of text block if opened
let toolIndexMap = new Map();   // OpenAI tc.index → {anthropicIdx, argsBuffer}
let nextBlockIdx = 0;
```

### Per-chunk algorithm

1. If `!started`: emit `message_start`; `started = true`.

2. If `delta.content` non-empty:
   - If `currentBlockIdx != textBlockIdx`:
     - If `currentBlockIdx != -1`: emit `content_block_stop(currentBlockIdx)`
     - If `textBlockIdx == -1`: allocate `textBlockIdx = nextBlockIdx++`, emit `content_block_start(index=textBlockIdx, type:"text")`
     - `currentBlockIdx = textBlockIdx`
   - Emit `content_block_delta(textBlockIdx, text_delta)`

3. For each `tc` in `delta.tool_calls`:
   - If `!toolIndexMap.has(tc.index)`:
     - Close current block if any: emit `content_block_stop(currentBlockIdx)`
     - `anthropicIdx = nextBlockIdx++`
     - Store `{anthropicIdx, argsBuffer:""}` in map
     - Emit `content_block_start(index=anthropicIdx, type:"tool_use", id, name, input:{})`
     - `currentBlockIdx = anthropicIdx`
   - If `tc.function?.arguments`:
     - Append to `argsBuffer`
     - Emit `content_block_delta(anthropicIdx, type:"input_json_delta", partial_json: tc.function.arguments)`

4. If `finish_reason`: `stopReason = mapStopReason(finish_reason)`, record `outputTokens`.

5. On upstream `end`:
   - If `currentBlockIdx != -1`: emit `content_block_stop(currentBlockIdx)`
   - Emit `message_delta(stop_reason: stopReason)`, `message_stop`.

### Edge cases

- Text-only stream: works as today.
- Tool-only stream: text block not opened; first block is tool_use at index 0.
- Interleaved text → tool → text: close current, open new (Anthropic supports this).
- Multiple parallel tool_calls: separate map entries keyed by `tc.index`; blocks emitted sequentially in Anthropic stream.
- Malformed partial JSON: not parsed during stream — passed through as `partial_json`. Client accumulates.
- Missing `id`/`name` on first appearance: generate `toolu_proxy_<timestamp>_<idx>` fallback, log warning.
- Chunk boundary mid-JSON: existing `buf` split-by-newline handles this.

## Testing

New file `test/tools.test.js` on `node:test`.

### Request conversion
- `tools[]` mapping `input_schema` → `parameters`, function wrapper
- Empty `tools[]` → field omitted
- `tool_choice` all four variants
- Assistant message: text-only / tool_use-only / text + tool_use
- User message: tool_result string / array / is_error
- Multiple tool_results + text in one user message: correct ordering
- Nested objects in `tool_use.input` → valid JSON string `arguments`

### Response conversion
- Text-only choice
- Tool-only choice
- Text + tool_calls
- `finish_reason:"tool_calls"` → `stop_reason:"tool_use"`
- Malformed JSON `arguments` → `input:{}`, no throw
- Multiple tool_calls → correct order in content

### Streaming
Mock upstream with `stream.PassThrough`, feed crafted SSE chunks, capture output events.
- Text-only stream → correct event sequence
- Tool-only stream → correct event sequence with id/name
- Text + tool stream → proper close/open between blocks
- Two parallel tool_calls → two blocks, indexes 0 and 1
- `finish_reason:"tool_calls"` → `stop_reason:"tool_use"` in `message_delta`
- Missing id/name → fallback id + warning

### Smoke
Extend `test/smoke.test.js` with one case: POST with `tools` → verify proxy sends correct upstream body.

## Exports

Add to `module.exports` at bottom of `proxy.js`:
- `convertAnthropicToolsToOpenAI`
- `convertToolChoice`
- `convertMessages`
- `openAIChoiceToAnthropicContent`
- `streamOpenAIToAnthropic` (already accessible? — expose for testing)

## Non-Goals

- No model whitelist for tool-capable models. If a model rejects tools, the provider's error is forwarded as-is.
- No retry logic for malformed responses.
- No vision/image support in tool_result.
