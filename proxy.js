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
        prov.prefixRegex = new RegExp(`^${prov.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
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

// Shared prefix-matching core used by resolveProvider and routeModel.
// Prefix-check must come before -cloud regex (or-something-cloud → openrouter, not ollama-cloud).
function classifyModel(modelName) {
    if (!modelName) return { name: CONFIG.defaultProvider || 'ollama', config: null };
    if (modelName.startsWith('claude-')) return { name: 'anthropic', config: null };
    for (const { prefix, name, config } of PROVIDER_PREFIXES) {
        if (modelName.startsWith(prefix)) return { name, config };
    }
    if (/-cloud(\b|$|:)/.test(modelName)) {
        const cfg = CONFIG.providers?.['ollama-cloud'];
        return { name: 'ollama-cloud', config: cfg || null };
    }
    return { name: 'ollama', config: null };
}

function resolveProvider(modelName) {
    if (!modelName) return { id: 'ollama', ...PROVIDER_META.ollama };
    const { name } = classifyModel(modelName);
    return { id: name, ...(PROVIDER_META[name] || PROVIDER_META.ollama) };
}

// ── LRU cache helper (insertion-order Map) ──────────────────────────────────

function lruSet(map, key, val, max = 200) {
    if (map.has(key)) map.delete(key);
    map.set(key, val);
    if (map.size > max) {
        const oldest = map.keys().next().value;
        map.delete(oldest);
    }
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

function normalizeOpenRouterAuthKey(apiResponse) {
    const data = apiResponse?.data || {};
    const credits = typeof data.limit === 'number' ? data.limit : 0;
    const isFree = data.is_free_tier === true;
    // Free tier: 50 rpd; with ≥10 credits: 1000 rpd
    const rpdLimit = isFree || credits < 10 ? 50 : 1000;
    return {
        short: null,
        long: {
            label: 'req/day',
            used: 0,
            limit: rpdLimit,
            pct: 0,
            resets_at: null,
        },
    };
}

async function fetchOpenRouterUsage() {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return null;
    try {
        const data = await fetchJson(true, {
            hostname: 'openrouter.ai', port: 443,
            path: '/api/v1/auth/key', method: 'GET',
            protocol: 'https:',
            headers: { 'authorization': `Bearer ${apiKey}` },
        }, 5000);
        return normalizeOpenRouterAuthKey(data);
    } catch (e) {
        log(`[OpenRouter Usage] fetch failed: ${e.message}`);
        return null;
    }
}

function normalizeHfWhoami(api) {
    const u = api?.inferenceProvidersUsage;
    if (!u) return { short: null, long: null };
    const used = typeof u.usageCents === 'number' ? u.usageCents : 0;
    let limit = typeof u.limitCents === 'number' ? u.limitCents : null;
    if (!limit) limit = api.isPro ? 200000 : 10000;  // PRO $20 / Free $0.10
    return {
        short: null,
        long: {
            label: 'credits/mo',
            used, limit,
            pct: parsePct(used, limit),
            resets_at: api.periodEnd || null,
        },
    };
}

async function fetchHuggingFaceUsage() {
    const apiKey = process.env.HF_TOKEN;
    if (!apiKey) return null;
    try {
        const data = await fetchJson(true, {
            hostname: 'huggingface.co', port: 443,
            path: '/api/whoami-v2', method: 'GET',
            protocol: 'https:',
            headers: { 'authorization': `Bearer ${apiKey}` },
        }, 5000);
        return normalizeHfWhoami(data);
    } catch (e) {
        log(`[HF Usage] fetch failed: ${e.message}`);
        return null;
    }
}

function normalizeOllamaCloudPlan(api) {
    if (!api || !api.Plan) return null;
    const periodEnd = api.SubscriptionPeriodEnd;
    const resetsAt = (periodEnd && periodEnd.Valid && periodEnd.Time)
        ? Math.floor(new Date(periodEnd.Time).getTime() / 1000)
        : null;
    return {
        plan: api.Plan,
        short: null,
        long: {
            label: 'weekly',
            used: 0,   // unknown until 429 — updated on limit hit
            limit: null,
            pct: 0,
            resets_at: resetsAt,
        },
    };
}

async function fetchOllamaCloudPlan() {
    const apiKey = process.env.OLLAMA_API_KEY;
    if (!apiKey) return null;
    try {
        const body = '{}';
        const data = await fetchJson(true, {
            hostname: 'ollama.com', port: 443,
            path: '/api/me', method: 'POST',
            protocol: 'https:',
            headers: {
                'authorization': `Bearer ${apiKey}`,
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
            },
        }, 5000, body);
        return normalizeOllamaCloudPlan(data);
    } catch (e) {
        log(`[OllamaCloud Plan] fetch failed: ${e.message}`);
        return null;
    }
}

function extractContextWindow(entry) {
    if (!entry) return null;
    // OpenAI /v1/models format (OpenRouter, Groq, HF)
    if (typeof entry.context_length === 'number') return entry.context_length;
    if (entry.top_provider && typeof entry.top_provider.context_length === 'number') {
        return entry.top_provider.context_length;
    }
    // Ollama /api/tags format
    if (entry.details && typeof entry.details.num_ctx === 'number') return entry.details.num_ctx;
    // Ollama /api/show format (model_info keys like 'llama.context_length', 'qwen2.context_length')
    if (entry.model_info) {
        const key = Object.keys(entry.model_info).find(k => k.endsWith('.context_length'));
        if (key && typeof entry.model_info[key] === 'number') return entry.model_info[key];
    }
    return null;
}

// Cache: `${providerId}:${modelId}` → context_window number
const ctxWindowCache = new Map();

async function fetchContextWindow(providerId, modelId) {
    const cacheKey = `${providerId}:${modelId}`;
    if (ctxWindowCache.has(cacheKey)) return ctxWindowCache.get(cacheKey);

    let ctx = null;
    try {
        if (providerId === 'openrouter') {
            const apiKey = process.env.OPENROUTER_API_KEY;
            if (!apiKey) return null;
            const data = await fetchJson(true, {
                hostname: 'openrouter.ai', port: 443,
                path: `/api/v1/models/${encodeURIComponent(modelId.replace(/^or-/, ''))}`,
                method: 'GET', protocol: 'https:',
                headers: { 'authorization': `Bearer ${apiKey}` },
            }, 5000);
            ctx = extractContextWindow(data?.data || data);
        } else if (providerId === 'groq') {
            const apiKey = process.env.GROQ_API_KEY;
            if (!apiKey) return null;
            const data = await fetchJson(true, {
                hostname: 'api.groq.com', port: 443,
                path: '/openai/v1/models', method: 'GET', protocol: 'https:',
                headers: { 'authorization': `Bearer ${apiKey}` },
            }, 5000);
            const model = (data?.data || []).find(m => m.id === modelId.replace(/^groq-/, ''));
            ctx = model ? extractContextWindow(model) : null;
        } else if (providerId === 'ollama') {
            const body = JSON.stringify({ name: modelId });
            ctx = await fetchJson(false, {
                hostname: '127.0.0.1', port: OLLAMA_PORT,
                path: '/api/show', method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body),
                },
            }, 5000, body)
                .then(data => extractContextWindow(data))
                .catch(() => null);
        }
    } catch (e) {
        log(`[CtxWindow] ${providerId}/${modelId}: ${e.message}`);
    }

    if (ctx !== null) lruSet(ctxWindowCache, cacheKey, ctx);
    return ctx;
}

// TTL cache for cold-path fetchers (5 min)
const USAGE_TTL_SEC = 300;
const usageFetchCache = new Map();

async function refreshUsageForProvider(providerId) {
    const cached = usageFetchCache.get(providerId);
    const now = Math.floor(Date.now() / 1000);
    if (cached && now - cached.at < USAGE_TTL_SEC) return cached.value;

    let usage = null;
    if (providerId === 'openrouter') usage = await fetchOpenRouterUsage();
    else if (providerId === 'huggingface') usage = await fetchHuggingFaceUsage();
    else if (providerId === 'ollama-cloud') usage = await fetchOllamaCloudPlan();

    if (usage) {
        lruSet(usageFetchCache, providerId, { at: now, value: usage }, 50);
        setProviderState(providerId, {
            usageShort: usage.short,
            usageLong: usage.long,
            ...(usage.plan ? { plan: usage.plan } : {}),
            stale: false,
        });
    } else {
        const existing = getProviderState(providerId);
        if (existing) setProviderState(providerId, { stale: true });
    }
    return usage;
}

// ── Logging ─────────────────────────────────────────────────────────────────

function log(message) {
    const msg = `[${new Date().toISOString()}] ${message}\n`;
    try { fs.appendFileSync(LOG_FILE, msg); } catch (e) { /* ignore */ }
}

// ── OAuth credentials ───────────────────────────────────────────────────────

let credsCache = { mtimeMs: 0, token: null };
function getOAuthToken() {
    try {
        const stat = fs.statSync(CREDENTIALS_FILE);
        if (stat.mtimeMs === credsCache.mtimeMs) return credsCache.token;
        const creds = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
        const token = creds?.claudeAiOauth?.accessToken || null;
        credsCache = { mtimeMs: stat.mtimeMs, token };
        return token;
    } catch (e) {
        credsCache = { mtimeMs: 0, token: null };
        return null;
    }
}

// ── Model → Provider routing ────────────────────────────────────────────────

// Returns: { target: 'cloud'|'ollama'|<provider-name>, providerConfig: {...}|null, unconfiguredCloud?: true }
function routeModel(modelName) {
    const { name, config } = classifyModel(modelName);
    if (name === 'anthropic') return { target: 'cloud', providerConfig: null };
    // *-cloud without configured provider → fall back to local Ollama
    if (name === 'ollama-cloud' && !config) return { target: 'ollama', providerConfig: null, unconfiguredCloud: true };
    return { target: name, providerConfig: config };
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
    if (body.stream != null) {
        out.stream = body.stream;
        if (body.stream) out.stream_options = { include_usage: true };
    }
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
        if (res.writableEnded) return;
        try {
            if (!started) {
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
            }
            emitSSE(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
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

const SIG_MARKER = 'PROXYFAKE';
function generateSignature() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let sig = SIG_MARKER;
    while (sig.length < 180) sig += chars[Math.floor(Math.random() * chars.length)];
    return sig.slice(0, 180);
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
                // Our injection fingerprint: explicit marker prefix (new format)
                if (sig.startsWith(SIG_MARKER)) return false;
                // Backwards compat: legacy injections were 180 chars of base64 alphabet without padding
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

function forwardToOllama(req, res, bodyBuffer, parsedBody) {
    let headers = { ...req.headers };
    headers['host'] = `${OLLAMA_HOST}:${OLLAMA_PORT}`;
    headers['authorization'] = 'Bearer ollama';

    // Detect model from caller-provided parsedBody (avoid re-parsing the buffer)
    const modelName = parsedBody?.model || null;
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

    proxyReq.end(actualBody || undefined);
}

// ── Forward to OpenAI-compatible provider (HuggingFace, OpenRouter, Groq) ───

function forwardToOpenAIProvider(providerName, providerConfig, req, res, parsedBody) {
    const apiKey = process.env[providerConfig.apiKeyEnv] || null;
    if (!apiKey) log(`[${providerName}] Warning: ${providerConfig.apiKeyEnv} is not set`);

    const originalModel = parsedBody.model;
    if (!originalModel) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request', message: 'model field is required' } }));
        return;
    }
    const actualModel = originalModel.replace(providerConfig.prefixRegex, '');
    const isStream = !!parsedBody.stream;

    const openAIBody = toOpenAI({ ...parsedBody, model: actualModel }, providerConfig);
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
                // Detect Ollama Cloud weekly limit from 429 body
                if (providerName === 'ollama-cloud' && upstreamRes.statusCode === 429) {
                    if (errBody.includes('weekly usage limit')) {
                        setProviderState('ollama-cloud', {
                            usageLong: { label: 'weekly', used: null, limit: null, pct: 100, resets_at: null },
                            stale: true,
                        });
                        log('[OllamaCloud] weekly usage limit reached');
                    }
                }
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

function fetchJson(useHttps, options, timeout = 5000, body = null) {
    return new Promise((resolve, reject) => {
        const transport = useHttps ? https : http;
        const req = transport.request(options, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`JSON parse: ${data.slice(0, 100)}`)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
        if (body) req.end(body); else req.end();
    });
}

// ── /v1/models — merged model list from all providers ───────────────────────

async function getMergedModels() {
    const tasks = [
        fetchJson(false, {
            hostname: OLLAMA_HOST, port: OLLAMA_PORT,
            path: '/v1/models', method: 'GET',
            headers: { host: `${OLLAMA_HOST}:${OLLAMA_PORT}` },
        }).then(ollama => {
            const models = ollama.data || [];
            log(`[Models] ${models.length} from Ollama`);
            return models;
        }).catch(e => { log(`[Models] Ollama failed: ${e.message}`); return []; }),
    ];

    for (const [name, prov] of Object.entries(CONFIG.providers || {})) {
        const apiKey = process.env[prov.apiKeyEnv];
        if (!apiKey) continue;

        let modelsPath = '/v1/models';
        if (name === 'openrouter') modelsPath = '/api/v1/models';
        if (name === 'groq') modelsPath = '/openai/v1/models';

        tasks.push(
            fetchJson(true, {
                hostname: prov.host, port: 443,
                path: modelsPath, method: 'GET',
                protocol: 'https:',
                headers: { 'authorization': `Bearer ${apiKey}`, 'user-agent': 'cloud-connect/1.0' },
            }).then(data => {
                const models = (data.data || []).map(m => ({ ...m, id: `${prov.prefix}${m.id}` }));
                const limited = models.slice(0, 50);
                log(`[Models] ${limited.length} from ${name} (${models.length} total)`);
                return limited;
            }).catch(e => { log(`[Models] ${name} failed: ${e.message}`); return []; })
        );
    }

    const results = (await Promise.all(tasks)).flat();
    log(`[Models] Total: ${results.length}`);
    return { data: results, has_more: false, object: 'list' };
}

// ── HTTP Server ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {

    // GET /status — provider state for statusbar
    if (req.url === '/status' && req.method === 'GET') {
        try {
            const providerId = getLastProvider() || 'ollama';
            // Cold-path refresh (non-blocking)
            if (['openrouter', 'huggingface', 'ollama-cloud'].includes(providerId)) {
                refreshUsageForProvider(providerId).catch(e => log(`[Status Refresh] ${e.message}`));
            }
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
            let parsedBody = null;
            let modelName = null;

            try {
                parsedBody = JSON.parse(bodyBuffer.toString());
                modelName = parsedBody.model || null;
            } catch (e) { /* non-JSON — route by default */ }

            const route = routeModel(modelName);
            const { target, providerConfig } = route;
            if (route.unconfiguredCloud) {
                log(`[Warning] Model "${modelName}" matches *-cloud but ollama-cloud not configured — falling back to local Ollama`);
            }

            // Record last-active provider for /status — use the actual routed target (not aspirational ollama-cloud)
            const providerId = target === 'cloud' ? 'anthropic' : target;
            setLastProvider(providerId);
            const modelDisplay = modelName ? String(modelName).split('/').pop().replace(/^[a-z]+-/, '').slice(0, 30) : null;
            setProviderState(providerId, { model: modelName, modelDisplay });

            // Async fetch context window — populates state for later /status calls
            fetchContextWindow(providerId, modelName).then(cw => {
                if (cw) setProviderState(providerId, { contextWindow: cw });
            }).catch(e => log(`[CtxWindow] ${e.message}`));

            log(`POST ${req.url} | model: ${modelName || 'unknown'} | target: ${target}`);

            if (target === 'cloud') return forwardToCloud(req, res, bodyBuffer);
            if (target === 'ollama') return forwardToOllama(req, res, bodyBuffer, parsedBody);

            // OpenAI-compatible provider
            if (providerConfig) {
                return forwardToOpenAIProvider(target, providerConfig, req, res, parsedBody);
            }

            // Fallback — shouldn't happen, but route to Ollama
            log(`[Warning] Unknown target "${target}", falling back to Ollama`);
            forwardToOllama(req, res, bodyBuffer, parsedBody);
        });
        return;
    }

    // HEAD, GET etc. — passthrough to cloud (for health checks etc.)
    log(`${req.method} ${req.url} | passthrough to cloud`);
    forwardToCloud(req, res, null);
});

server.on('error', (err) => {
    log(`[Server Error] ${err.message}`);
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} already in use — exiting`);
        process.exit(1);
    }
});

if (require.main === module) {
    const LISTEN_HOST = process.env.CLAUDE_PROXY_HOST || '127.0.0.1';
    server.listen(PORT, LISTEN_HOST, () => {
        const providerList = Object.keys(CONFIG.providers || {}).join(', ');
        log(`Cloud-Connect Proxy v1.0 started on ${LISTEN_HOST}:${PORT}`);
        log(`Ollama: ${OLLAMA_HOST}:${OLLAMA_PORT}`);
        log(`Providers: ${providerList || 'none'}`);
        log(`Default: ${CONFIG.defaultProvider || 'ollama'}`);
        console.log(`Cloud-Connect Proxy listening on ${LISTEN_HOST}:${PORT}`);
        console.log(`Providers: anthropic (cloud), ollama${providerList ? ', ' + providerList : ''}`);
    });
}

// ── Exports for testing ──────────────────────────────────────────────────────
module.exports = {
    resolveProvider, routeModel, PROVIDER_META,
    lruSet,
    providerState, setProviderState, getProviderState,
    setLastProvider, getLastProvider,
    extractGroqUsage,
    normalizeOpenRouterAuthKey, fetchOpenRouterUsage, refreshUsageForProvider,
    normalizeHfWhoami, fetchHuggingFaceUsage,
    normalizeOllamaCloudPlan, fetchOllamaCloudPlan,
    extractContextWindow, fetchContextWindow,
};
