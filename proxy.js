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
const PORT = CONFIG.port || 11436;
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

// ── Forward to Anthropic Cloud (passthrough) ────────────────────────────────

function forwardToCloud(req, res, bodyBuffer) {
    const headers = { ...req.headers };
    headers['host'] = CLOUD_HOST;
    headers['user-agent'] = headers['user-agent'] || 'claude-code/2.1.100';

    // Inject real OAuth token if available
    const token = getOAuthToken();
    if (token) headers['authorization'] = `Bearer ${token}`;

    if (bodyBuffer) headers['content-length'] = bodyBuffer.length;

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

    let actualBody = bodyBuffer;
    if (actualBody) {
        actualBody = sanitizeBodyForOllama(actualBody);
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
        }
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
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

server.listen(PORT, () => {
    const providerList = Object.keys(CONFIG.providers || {}).join(', ');
    log(`Cloud-Connect Proxy v1.0 started on port ${PORT}`);
    log(`Ollama: ${OLLAMA_HOST}:${OLLAMA_PORT}`);
    log(`Providers: ${providerList || 'none'}`);
    log(`Default: ${CONFIG.defaultProvider || 'ollama'}`);
    console.log(`Cloud-Connect Proxy listening on port ${PORT}`);
    console.log(`Providers: anthropic (cloud), ollama${providerList ? ', ' + providerList : ''}`);
});
