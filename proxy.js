const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Platform & paths ────────────────────────────────────────────────────────

const HOME = process.env.HOME || process.env.USERPROFILE;
const IS_WINDOWS = process.platform === 'win32';
const PROXY_DIR = path.join(HOME, '.claude-provider-proxy');
const CONFIG_FILE = path.join(PROXY_DIR, 'config.json');
const FALLBACK_CONFIG = path.join(__dirname, 'config.json');
const ENV_FILE = path.join(PROXY_DIR, 'proxy.env');
const LOG_FILE = path.join(PROXY_DIR, 'proxy_internal.log');
const CREDENTIALS_FILE = path.join(HOME, '.claude', '.credentials.json');
const CLOUD_HOST = 'api.anthropic.com';

// ── Load env file ───────────────────────────────────────────────────────────

function loadEnvFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq === -1) continue;
            const key = trimmed.slice(0, eq).trim();
            const val = trimmed.slice(eq + 1).trim();
            if (!process.env[key]) process.env[key] = val;
        }
    } catch (e) {
        // env file is optional
    }
}

loadEnvFile(ENV_FILE);

// ── Load config ─────────────────────────────────────────────────────────────

function loadConfig() {
    // Try PROXY_DIR first, then fallback to script directory
    for (const p of [CONFIG_FILE, FALLBACK_CONFIG]) {
        try {
            return JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch (e) { /* try next */ }
    }
    // Hardcoded defaults if no config found
    return {
        port: 11436,
        defaultProvider: 'ollama',
        ollama: { host: '127.0.0.1', port: 11435, portWindows: 11434 },
        providers: {}
    };
}

const CONFIG = loadConfig();
const PORT = parseInt(process.env.CLAUDE_PROXY_PORT || CONFIG.port || 11436, 10);
const OLLAMA_HOST = CONFIG.ollama?.host || '127.0.0.1';
const OLLAMA_PORT = IS_WINDOWS
    ? (CONFIG.ollama?.portWindows || 11434)
    : (CONFIG.ollama?.port || 11435);

// Build prefix→provider lookup from config
const PROVIDER_PREFIXES = [];
for (const [name, prov] of Object.entries(CONFIG.providers || {})) {
    if (prov.prefix) {
        PROVIDER_PREFIXES.push({ prefix: prov.prefix, name, config: prov });
    }
}

// ── Provider metadata (for /status endpoint) ────────────────────────────────

const PROVIDER_META = {
    anthropic:      { icon: '🟠', color: 'orange', display: 'ant'  },
    ollama:         { icon: '⚪', color: 'white',  display: 'oll'  },
    'ollama-cloud': { icon: '🔷', color: 'cyan',   display: 'ollc' },
    openrouter:     { icon: '🔵', color: 'blue',   display: 'or'   },
    groq:           { icon: '🔴', color: 'red',    display: 'groq' },
    huggingface:    { icon: '🟡', color: 'yellow', display: 'hf'   },
};

function resolveProvider(modelName) {
    if (!modelName) {
        return { id: 'ollama', ...PROVIDER_META.ollama };
    }
    if (modelName.startsWith('claude-')) {
        return { id: 'anthropic', ...PROVIDER_META.anthropic };
    }
    for (const { prefix, name } of PROVIDER_PREFIXES) {
        if (modelName.startsWith(prefix)) {
            return { id: name, ...PROVIDER_META[name] };
        }
    }
    // Ollama-cloud check must come after prefix matching (or-something-cloud → openrouter, not ollama-cloud)
    if (/-cloud(\b|$|:)/.test(modelName)) {
        return { id: 'ollama-cloud', ...PROVIDER_META['ollama-cloud'] };
    }
    return { id: 'ollama', ...PROVIDER_META.ollama };
}

// ── Provider state store (in-memory) ────────────────────────────────────────

const providerState = new Map();
let lastProvider = null;

function setProviderState(providerId, partial) {
    const existing = providerState.get(providerId) || {};
    providerState.set(providerId, {
        ...existing,
        ...partial,
        generated_at: Math.floor(Date.now() / 1000),
    });
}

function getProviderState(providerId) {
    return providerState.get(providerId) || null;
}

function setLastProvider(providerId) {
    lastProvider = providerId;
}

function getLastProvider() {
    return lastProvider;
}

// ── Provider usage extractors ───────────────────────────────────────────────

function parsePct(used, limit) {
    if (!limit || limit <= 0) return 0;
    return Math.round((used / limit) * 100);
}

function extractGroqUsage(headers) {
    const limReq = parseInt(headers['x-ratelimit-limit-requests'], 10);
    const remReq = parseInt(headers['x-ratelimit-remaining-requests'], 10);
    const limTok = parseInt(headers['x-ratelimit-limit-tokens'], 10);
    const remTok = parseInt(headers['x-ratelimit-remaining-tokens'], 10);

    let short = null;
    if (!isNaN(limReq) && !isNaN(remReq)) {
        const rpmUsed = limReq - remReq;
        const rpmPct = parsePct(rpmUsed, limReq);
        short = { label: 'rpm', used: rpmUsed, limit: limReq, pct: rpmPct, resets_at: null };
    }
    if (!isNaN(limTok) && !isNaN(remTok)) {
        const tpmUsed = limTok - remTok;
        const tpmPct = parsePct(tpmUsed, limTok);
        if (!short || tpmPct > short.pct) {
            short = { label: 'tpm', used: tpmUsed, limit: limTok, pct: tpmPct, resets_at: null };
        }
    }

    // Daily window — Groq returns these in some plans/models
    let long = null;
    const limDay = parseInt(headers['x-ratelimit-limit-requests-day'], 10);
    const remDay = parseInt(headers['x-ratelimit-remaining-requests-day'], 10);
    if (!isNaN(limDay) && !isNaN(remDay)) {
        const used = limDay - remDay;
        long = { label: 'rpd', used, limit: limDay, pct: parsePct(used, limDay), resets_at: null };
    }

    return { short, long };
}

// ── Logging ─────────────────────────────────────────────────────────────────

function log(message) {
    const msg = `[${new Date().toISOString()}] ${message}\n`;
    try { fs.appendFileSync(LOG_FILE, msg); } catch (e) { /* ignore */ }
}

// ── OAuth credentials ───────────────────────────────────────────────────────

function getOAuthToken() {
    try {
        const creds = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
        return creds?.claudeAiOauth?.accessToken || null;
    } catch (e) {
        return null;
    }
}

// ── Model → Provider routing ────────────────────────────────────────────────

// Returns: { target: 'cloud'|'ollama'|<provider-name>, providerConfig: {...}|null }
function routeModel(modelName) {
    if (!modelName) return { target: CONFIG.defaultProvider || 'ollama', providerConfig: null };
    if (modelName.startsWith('claude-')) return { target: 'cloud', providerConfig: null };

    for (const { prefix, name, config } of PROVIDER_PREFIXES) {
        if (modelName.startsWith(prefix)) {
            return { target: name, providerConfig: config };
        }
    }

    return { target: 'ollama', providerConfig: null };
}

// ── Anthropic ↔ OpenAI format conversion ────────────────────────────────────

function contentToString(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.filter(b => b.type === 'text').map(b => b.text).join('');
    }
    return String(content ?? '');
}

// Anthropic Messages → OpenAI chat/completions request body
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

    for (const msg of (body.messages || [])) {
        messages.push({ role: msg.role, content: contentToString(msg.content) });
    }

    const out = { messages, model: body.model };
    if (body.max_tokens != null) {
        const cap = providerConfig?.maxTokens;
        out.max_tokens = cap ? Math.min(body.max_tokens, cap) : body.max_tokens;
    }
    if (body.temperature != null) out.temperature = body.temperature;
    if (body.top_p != null) out.top_p = body.top_p;
    if (body.stream != null) out.stream = body.stream;
    if (body.stop_sequences) out.stop = body.stop_sequences;
    // thinking / betas are intentionally omitted — providers don't support them
    return out;
}

// OpenAI finish_reason → Anthropic stop_reason
function mapStopReason(reason) {
    if (reason === 'stop') return 'end_turn';
    if (reason === 'length') return 'max_tokens';
    return reason || 'end_turn';
}

// OpenAI chat/completions response → Anthropic Messages response (non-streaming)
function fromOpenAI(body, originalModel) {
    const choice = (body.choices || [])[0] || {};
    const text = choice.message?.content || '';
    const usage = body.usage || {};
    return {
        id: body.id || `msg_proxy_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text }],
        model: originalModel,
        stop_reason: mapStopReason(choice.finish_reason),
        stop_sequence: null,
        usage: {
            input_tokens: usage.prompt_tokens || 0,
            output_tokens: usage.completion_tokens || 0,
        },
    };
}

// ── Anthropic SSE helpers ───────────────────────────────────────────────────

function emitSSE(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Stream OpenAI SSE → Anthropic SSE
function streamOpenAIToAnthropic(upstreamRes, res, originalModel, msgId) {
    let started = false;
    let outputTokens = 0;
    let stopReason = 'end_turn';
    let buf = '';

    upstreamRes.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop(); // keep incomplete tail

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const raw = trimmed.slice(5).trim();
            if (raw === '[DONE]') continue;

            let parsed;
            try { parsed = JSON.parse(raw); } catch (e) { continue; }

            const choice = (parsed.choices || [])[0];
            if (!choice) continue;

            if (!started) {
                started = true;
                emitSSE(res, 'message_start', {
                    type: 'message_start',
                    message: {
                        id: msgId, type: 'message', role: 'assistant',
                        content: [], model: originalModel,
                        stop_reason: null, stop_sequence: null,
                        usage: { input_tokens: parsed.usage?.prompt_tokens || 0, output_tokens: 0 },
                    },
                });
                emitSSE(res, 'content_block_start', {
                    type: 'content_block_start', index: 0,
                    content_block: { type: 'text', text: '' },
                });
            }

            const text = choice.delta?.content;
            if (text) {
                emitSSE(res, 'content_block_delta', {
                    type: 'content_block_delta', index: 0,
                    delta: { type: 'text_delta', text },
                });
            }

            if (choice.finish_reason) {
                stopReason = mapStopReason(choice.finish_reason);
                outputTokens = parsed.usage?.completion_tokens || 0;
            }
        }
    });

    upstreamRes.on('end', () => {
        if (!started) {
            // Empty response — send a minimal valid Anthropic response
            emitSSE(res, 'message_start', {
                type: 'message_start',
                message: {
                    id: msgId, type: 'message', role: 'assistant',
                    content: [], model: originalModel,
                    stop_reason: null, stop_sequence: null,
                    usage: { input_tokens: 0, output_tokens: 0 },
                },
            });
            emitSSE(res, 'content_block_start', {
                type: 'content_block_start', index: 0,
                content_block: { type: 'text', text: '' },
            });
            emitSSE(res, 'content_block_delta', {
                type: 'content_block_delta', index: 0,
                delta: { type: 'text_delta', text: '(empty response from provider)' },
            });
        }
        emitSSE(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
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
        if (!res.writableEnded) res.end();
    });
}

// ── Ollama sanitization (strip thinking params) ─────────────────────────────

function sanitizeBodyForOllama(bodyBuffer) {
    try {
        const parsed = JSON.parse(bodyBuffer.toString());
        let modified = false;

        if (parsed.thinking) { delete parsed.thinking; modified = true; }
        if (parsed.betas) {
            parsed.betas = parsed.betas.filter(b => !b.includes('thinking'));
            if (parsed.betas.length === 0) delete parsed.betas;
            modified = true;
        }

        if (modified) {
            log('[Ollama] Stripped thinking params');
            return Buffer.from(JSON.stringify(parsed));
        }
    } catch (e) { /* not JSON — pass through */ }
    return bodyBuffer;
}

function sanitizeHeadersForOllama(headers) {
    const result = { ...headers };
    if (result['anthropic-beta']) {
        const betas = result['anthropic-beta'].split(',').map(s => s.trim())
            .filter(b => !b.includes('thinking') && !b.includes('interleaved'));
        if (betas.length > 0) {
            result['anthropic-beta'] = betas.join(',');
        } else {
            delete result['anthropic-beta'];
        }
    }
    return result;
}

// ── Thinking support for Ollama (whitelist + signature injection) ───────────

function modelSupportsThinking(modelName) {
    if (!modelName) return false;
    const list = CONFIG.ollama?.thinkingSupported || [];
    return list.some(entry => modelName === entry || modelName.startsWith(entry));
}

function generateSignature() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let sig = '';
    for (let i = 0; i < 180; i++) sig += chars[Math.floor(Math.random() * chars.length)];
    return sig;
}

function injectSignatureIntoOllamaJson(bodyStr) {
    try {
        const parsed = JSON.parse(bodyStr);
        if (!parsed.content || !Array.isArray(parsed.content)) return bodyStr;
        let modified = false;
        for (const block of parsed.content) {
            if (block.type === 'thinking' && !block.signature) {
                block.signature = generateSignature();
                modified = true;
            }
        }
        if (modified) {
            log('[Ollama] Injected signature into thinking block (non-streaming)');
            return JSON.stringify(parsed);
        }
    } catch (e) { /* not JSON — pass through */ }
    return bodyStr;
}

function pipeOllamaStreamWithSignature(upstream, downstream) {
    let buf = '';
    const thinkingBlocks = new Set();

    upstream.on('data', chunk => {
        buf += chunk.toString();
        const events = buf.split('\n\n');
        buf = events.pop();

        for (const rawEvent of events) {
            if (!rawEvent) continue;

            let dataLine = null;
            for (const line of rawEvent.split('\n')) {
                if (line.startsWith('data:')) { dataLine = line.slice(5).trim(); break; }
            }

            let data = null;
            if (dataLine) { try { data = JSON.parse(dataLine); } catch (e) {} }

            if (data?.type === 'content_block_start' && data.content_block?.type === 'thinking') {
                thinkingBlocks.add(data.index);
            }

            if (data?.type === 'content_block_stop' && thinkingBlocks.has(data.index)) {
                const sigEvent = {
                    type: 'content_block_delta',
                    index: data.index,
                    delta: { type: 'signature_delta', signature: generateSignature() },
                };
                downstream.write(`event: content_block_delta\ndata: ${JSON.stringify(sigEvent)}\n\n`);
                thinkingBlocks.delete(data.index);
                log(`[Ollama] Injected signature_delta for thinking block ${data.index}`);
            }

            downstream.write(rawEvent + '\n\n');
        }
    });

    upstream.on('end', () => {
        if (buf) downstream.write(buf);
        downstream.end();
    });

    upstream.on('error', (err) => {
        log(`[Ollama Stream Error] ${err.message}`);
        if (!downstream.writableEnded) downstream.end();
    });
}

// ── Sanitize history before cloud (strip fake thinking signatures) ──────────

// When the user switches from an Ollama thinking-capable model back to Claude,
// the conversation history contains thinking blocks with signatures we fabricated
// (180 chars of [A-Za-z0-9+/]). Anthropic rejects these with 400. Also strip
// thinking blocks missing a signature entirely.
function sanitizeBodyForCloud(bodyBuffer) {
    try {
        const parsed = JSON.parse(bodyBuffer.toString());
        if (!Array.isArray(parsed.messages)) return bodyBuffer;
        let stripped = 0;
        for (const msg of parsed.messages) {
            if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
            const before = msg.content.length;
            msg.content = msg.content.filter(block => {
                if (block.type !== 'thinking') return true;
                const sig = block.signature || '';
                if (!sig) return false;
                // Our injection fingerprint: exactly 180 chars from base64 alphabet
                if (sig.length === 180 && /^[A-Za-z0-9+/]+$/.test(sig)) return false;
                return true;
            });
            stripped += before - msg.content.length;
        }
        if (stripped > 0) {
            log(`[Cloud] Stripped ${stripped} fake/empty-signature thinking block(s) from history`);
            return Buffer.from(JSON.stringify(parsed));
        }
    } catch (e) { /* not JSON — pass through */ }
    return bodyBuffer;
}

// ── Forward to Anthropic Cloud (passthrough) ────────────────────────────────

function forwardToCloud(req, res, bodyBuffer) {
    const headers = { ...req.headers };
    headers['host'] = CLOUD_HOST;
    headers['user-agent'] = headers['user-agent'] || 'claude-code/2.1.100';

    // Inject real OAuth token if available
    const token = getOAuthToken();
    if (token) headers['authorization'] = `Bearer ${token}`;

    if (bodyBuffer) {
        bodyBuffer = sanitizeBodyForCloud(bodyBuffer);
        headers['content-length'] = bodyBuffer.length;
    }

    const options = {
        hostname: CLOUD_HOST, port: 443, path: req.url,
        method: req.method, headers, protocol: 'https:',
    };

    const proxyReq = https.request(options, (proxyRes) => {
        log(`[Cloud Response] status=${proxyRes.statusCode} url=${req.url}`);
        if (proxyRes.statusCode >= 400) {
            let errBody = '';
            proxyRes.on('data', c => errBody += c);
            proxyRes.on('end', () => log(`[Cloud Error] ${errBody.slice(0, 300)}`));
        }
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        log(`[Cloud Error] ${err.message}`);
        if (!res.headersSent) { res.writeHead(502); res.end('Cloud unreachable'); }
    });

    proxyReq.setTimeout(120000, () => { proxyReq.destroy(); });

    if (bodyBuffer) proxyReq.end(bodyBuffer);
    else req.pipe(proxyReq);
}

// ── Forward to Ollama (Anthropic-native with sanitization) ──────────────────

function forwardToOllama(req, res, bodyBuffer) {
    let headers = { ...req.headers };
    headers['host'] = `${OLLAMA_HOST}:${OLLAMA_PORT}`;
    headers['authorization'] = 'Bearer ollama';

    // Detect model and whether it supports thinking
    let modelName = null;
    try {
        const parsed = JSON.parse((bodyBuffer || Buffer.from('{}')).toString());
        modelName = parsed.model || null;
    } catch (e) { /* ignore */ }
    const thinkingMode = modelSupportsThinking(modelName);

    let actualBody = bodyBuffer;
    if (actualBody) {
        // Only strip thinking params if model does NOT support thinking
        if (!thinkingMode) {
            actualBody = sanitizeBodyForOllama(actualBody);
        } else {
            log(`[Ollama] Thinking mode enabled for model: ${modelName}`);
        }
        headers['content-length'] = actualBody.length;
    }
    headers = sanitizeHeadersForOllama(headers);

    const options = {
        hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: req.url,
        method: req.method, headers,
    };

    const proxyReq = http.request(options, (proxyRes) => {
        log(`[Ollama Response] status=${proxyRes.statusCode} url=${req.url}`);
        if (proxyRes.statusCode >= 400) {
            let errBody = '';
            proxyRes.on('data', c => errBody += c);
            proxyRes.on('end', () => log(`[Ollama Error] ${errBody.slice(0, 300)}`));
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
            return;
        }

        if (thinkingMode) {
            const contentType = proxyRes.headers['content-type'] || '';
            const isStream = contentType.includes('event-stream');

            if (isStream) {
                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                pipeOllamaStreamWithSignature(proxyRes, res);
            } else {
                // Buffer, inject signature, send
                let body = '';
                proxyRes.on('data', c => body += c);
                proxyRes.on('end', () => {
                    const transformed = injectSignatureIntoOllamaJson(body);
                    const outHeaders = { ...proxyRes.headers };
                    outHeaders['content-length'] = Buffer.byteLength(transformed);
                    res.writeHead(proxyRes.statusCode, outHeaders);
                    res.end(transformed);
                });
                proxyRes.on('error', (err) => {
                    log(`[Ollama Response Error] ${err.message}`);
                    if (!res.writableEnded) res.end();
                });
            }
        } else {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        }
    });

    proxyReq.on('error', (err) => {
        log(`[Ollama Error] ${err.message}`);
        if (!res.headersSent) { res.writeHead(502); res.end('Ollama unreachable'); }
    });

    // Large models may take a while to load
    proxyReq.setTimeout(600000, () => { proxyReq.destroy(); });

    if (actualBody) proxyReq.end(actualBody);
    else req.pipe(proxyReq);
}

// ── Forward to OpenAI-compatible provider (HuggingFace, OpenRouter, Groq) ───

function forwardToOpenAIProvider(providerName, providerConfig, req, res, bodyBuffer) {
    const apiKey = process.env[providerConfig.apiKeyEnv] || null;
    if (!apiKey) log(`[${providerName}] Warning: ${providerConfig.apiKeyEnv} is not set`);

    let parsed;
    try { parsed = JSON.parse(bodyBuffer.toString()); }
    catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request', message: 'Invalid JSON body' } }));
        return;
    }

    const originalModel = parsed.model;
    // Strip provider prefix from model name to get the actual model ID
    const actualModel = originalModel.replace(new RegExp(`^${providerConfig.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '');
    const isStream = !!parsed.stream;

    const openAIBody = toOpenAI({ ...parsed, model: actualModel }, providerConfig);
    const bodyStr = JSON.stringify(openAIBody);

    const apiPath = providerConfig.path || '/v1/chat/completions';

    const options = {
        hostname: providerConfig.host,
        port: 443,
        path: apiPath,
        method: 'POST',
        protocol: 'https:',
        headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(bodyStr),
            'authorization': `Bearer ${apiKey || ''}`,
            'user-agent': 'cloud-connect/1.0',
        },
    };

    // OpenRouter wants extra headers
    if (providerName === 'openrouter') {
        options.headers['http-referer'] = 'https://github.com/mstoliarov/cloud-connect';
        options.headers['x-title'] = 'Cloud-Connect Proxy';
    }

    log(`[${providerName}] POST model=${actualModel} stream=${isStream}`);

    const proxyReq = https.request(options, (upstreamRes) => {
        log(`[${providerName} Response] status=${upstreamRes.statusCode}`);

        // Extract rate-limit info for /status (Groq provides x-ratelimit-* headers)
        if (providerName === 'groq') {
            const usage = extractGroqUsage(upstreamRes.headers);
            setProviderState('groq', {
                usageShort: usage.short,
                usageLong: usage.long,
            });
        }

        if (upstreamRes.statusCode >= 400) {
            let errBody = '';
            upstreamRes.on('data', c => errBody += c);
            upstreamRes.on('end', () => {
                log(`[${providerName} Error] ${upstreamRes.statusCode} ${errBody.slice(0, 300)}`);
                if (!res.headersSent) {
                    res.writeHead(upstreamRes.statusCode, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({
                        type: 'error',
                        error: { type: 'api_error', message: `${providerName} error ${upstreamRes.statusCode}: ${errBody.slice(0, 200)}` },
                    }));
                }
            });
            return;
        }

        if (isStream) {
            res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                'transfer-encoding': 'chunked',
            });
            const msgId = `msg_${providerName}_${Date.now()}`;
            streamOpenAIToAnthropic(upstreamRes, res, originalModel, msgId);
        } else {
            let body = '';
            upstreamRes.on('data', c => body += c);
            upstreamRes.on('end', () => {
                try {
                    const openAI = JSON.parse(body);
                    const anthropic = fromOpenAI(openAI, originalModel);
                    const out = JSON.stringify(anthropic);
                    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) });
                    res.end(out);
                } catch (e) {
                    log(`[${providerName} Parse Error] ${e.message}`);
                    res.writeHead(502);
                    res.end(`Failed to parse ${providerName} response`);
                }
            });
        }
    });

    proxyReq.on('error', (err) => {
        log(`[${providerName} Error] ${err.message}`);
        if (!res.headersSent) { res.writeHead(502); res.end(`${providerName} unreachable`); }
    });

    proxyReq.setTimeout(120000, () => {
        log(`[${providerName}] Request timeout`);
        proxyReq.destroy();
    });

    proxyReq.end(bodyStr);
}

// ── Fetch JSON helper ───────────────────────────────────────────────────────

function fetchJson(useHttps, options, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const transport = useHttps ? https : http;
        const req = transport.request(options, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error(`JSON parse: ${body.slice(0, 100)}`)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
    });
}

// ── /v1/models — merged model list from all providers ───────────────────────

async function getMergedModels() {
    const results = [];

    // Ollama models
    try {
        const ollama = await fetchJson(false, {
            hostname: OLLAMA_HOST, port: OLLAMA_PORT,
            path: '/v1/models', method: 'GET',
            headers: { host: `${OLLAMA_HOST}:${OLLAMA_PORT}` },
        });
        const models = ollama.data || [];
        results.push(...models);
        log(`[Models] ${models.length} from Ollama`);
    } catch (e) {
        log(`[Models] Ollama failed: ${e.message}`);
    }

    // OpenAI-compat providers — fetch their model lists and add prefixes
    for (const [name, prov] of Object.entries(CONFIG.providers || {})) {
        const apiKey = process.env[prov.apiKeyEnv];
        if (!apiKey) continue; // skip providers without API keys

        try {
            // Determine models endpoint
            let modelsPath = '/v1/models';
            if (name === 'openrouter') modelsPath = '/api/v1/models';
            if (name === 'groq') modelsPath = '/openai/v1/models';

            const data = await fetchJson(true, {
                hostname: prov.host, port: 443,
                path: modelsPath, method: 'GET',
                protocol: 'https:',
                headers: {
                    'authorization': `Bearer ${apiKey}`,
                    'user-agent': 'cloud-connect/1.0',
                },
            });

            const models = (data.data || []).map(m => ({
                ...m,
                id: `${prov.prefix}${m.id}`,
            }));

            // Limit to first 50 models per provider to keep the list manageable
            const limited = models.slice(0, 50);
            results.push(...limited);
            log(`[Models] ${limited.length} from ${name} (${models.length} total)`);
        } catch (e) {
            log(`[Models] ${name} failed: ${e.message}`);
        }
    }

    log(`[Models] Total: ${results.length}`);
    return { data: results, has_more: false, object: 'list' };
}

// ── HTTP Server ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {

    // GET /status — provider state for statusbar
    if (req.url === '/status' && req.method === 'GET') {
        try {
            const providerId = getLastProvider() || 'ollama';
            const meta = PROVIDER_META[providerId] || PROVIDER_META.ollama;
            const state = getProviderState(providerId) || {};
            const nowSec = Math.floor(Date.now() / 1000);
            const body = JSON.stringify({
                provider: { id: providerId, ...meta },
                model: {
                    id: state.model || null,
                    display: state.modelDisplay || null,
                    context_window: state.contextWindow || null,
                },
                usage: {
                    short: state.usageShort || null,
                    long: state.usageLong || null,
                },
                generated_at: state.generated_at || nowSec,
                stale: state.stale || false,
            });
            res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
            res.end(body);
        } catch (e) {
            log(`[Status Error] ${e.message}`);
            res.writeHead(500);
            res.end('Internal error');
        }
        return;
    }

    // GET /v1/models — merged list
    if (req.url === '/v1/models' && req.method === 'GET') {
        try {
            const merged = await getMergedModels();
            const body = JSON.stringify(merged);
            res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
            res.end(body);
        } catch (e) {
            log(`[Models Error] ${e.message}`);
            res.writeHead(500);
            res.end('Failed to list models');
        }
        return;
    }

    // POST — buffer body, inspect model, route
    if (req.method === 'POST') {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const bodyBuffer = Buffer.concat(chunks);
            let modelName = null;

            try {
                const parsed = JSON.parse(bodyBuffer.toString());
                modelName = parsed.model || null;
            } catch (e) { /* non-JSON — route by default */ }

            const { target, providerConfig } = routeModel(modelName);

            // Record last-active provider for /status
            const providerId = resolveProvider(modelName).id;
            setLastProvider(providerId);
            const modelDisplay = modelName ? String(modelName).split('/').pop().replace(/^[a-z]+-/, '').slice(0, 30) : null;
            setProviderState(providerId, { model: modelName, modelDisplay });

            log(`POST ${req.url} | model: ${modelName || 'unknown'} | target: ${target}`);

            if (target === 'cloud') return forwardToCloud(req, res, bodyBuffer);
            if (target === 'ollama') return forwardToOllama(req, res, bodyBuffer);

            // OpenAI-compatible provider
            if (providerConfig) {
                return forwardToOpenAIProvider(target, providerConfig, req, res, bodyBuffer);
            }

            // Fallback — shouldn't happen, but route to Ollama
            log(`[Warning] Unknown target "${target}", falling back to Ollama`);
            forwardToOllama(req, res, bodyBuffer);
        });
        return;
    }

    // HEAD, GET etc. — passthrough to cloud (for health checks etc.)
    log(`${req.method} ${req.url} | passthrough to cloud`);
    forwardToCloud(req, res, null);
});

server.on('error', (err) => {
    log(`[Server Error] ${err.message}`);
});

if (require.main === module) {
    server.listen(PORT, () => {
        const providerList = Object.keys(CONFIG.providers || {}).join(', ');
        log(`Cloud-Connect Proxy v1.0 started on port ${PORT}`);
        log(`Ollama: ${OLLAMA_HOST}:${OLLAMA_PORT}`);
        log(`Providers: ${providerList || 'none'}`);
        log(`Default: ${CONFIG.defaultProvider || 'ollama'}`);
        console.log(`Cloud-Connect Proxy listening on port ${PORT}`);
        console.log(`Providers: anthropic (cloud), ollama${providerList ? ', ' + providerList : ''}`);
    });
}

// ── Exports for testing ──────────────────────────────────────────────────────
module.exports = {
    resolveProvider, PROVIDER_META,
    providerState, setProviderState, getProviderState,
    setLastProvider, getLastProvider,
    extractGroqUsage,
};
