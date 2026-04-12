const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 11436;
const OLLAMA_HOST = 'localhost';
const OLLAMA_PORT = 11435;
const CLOUD_HOST = 'api.anthropic.com';
const MODE_FILE = path.join(process.env.HOME, '.claude-provider-proxy/mode.txt');
const LOG_FILE = path.join(process.env.HOME, '.claude-provider-proxy/proxy_internal.log');

function log(message) {
    const msg = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, msg);
}

function getMode() {
    try {
        return fs.readFileSync(MODE_FILE, 'utf8').trim().toLowerCase();
    } catch (e) {
        return 'ollama';
    }
}

// Determine target based on model name in request body
// Claude models (claude-*) always go to cloud
// Everything else goes to ollama
function getTargetForModel(modelName, mode) {
    if (!modelName) return mode === 'cloud' ? 'cloud' : 'ollama';
    if (modelName.startsWith('claude-')) return 'cloud';
    return 'ollama';
}

// Strip thinking-related fields for Ollama requests (Ollama doesn't support signature field)
function sanitizeForOllama(bodyBuffer, reqHeaders) {
    try {
        const parsed = JSON.parse(bodyBuffer.toString());
        let modified = false;

        // Remove thinking parameter
        if (parsed.thinking) {
            delete parsed.thinking;
            modified = true;
        }

        // Remove betas that Ollama doesn't support
        if (parsed.betas) {
            parsed.betas = parsed.betas.filter(b => !b.includes('thinking'));
            if (parsed.betas.length === 0) delete parsed.betas;
            modified = true;
        }

        if (modified) {
            log(`[Ollama] Stripped thinking params from request`);
            return Buffer.from(JSON.stringify(parsed));
        }
    } catch (e) {
        // Not JSON or parse error — return as-is
    }
    return bodyBuffer;
}

// Strip thinking-related beta headers for Ollama
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

// Forward request to the specified target
function forwardTo(target, req, res, bodyBuffer) {
    const isCloud = target === 'cloud';
    let headers = { ...req.headers };
    let actualBody = bodyBuffer;

    if (isCloud) {
        headers['host'] = CLOUD_HOST;
        headers['user-agent'] = 'claude-code/2.1.100';
    } else {
        headers['host'] = `${OLLAMA_HOST}:${OLLAMA_PORT}`;
        // Strip thinking for Ollama — it doesn't return required 'signature' field
        if (actualBody) {
            actualBody = sanitizeForOllama(actualBody, headers);
        }
        headers = sanitizeHeadersForOllama(headers);
    }

    if (actualBody) {
        headers['content-length'] = actualBody.length;
    }

    const options = {
        hostname: isCloud ? CLOUD_HOST : OLLAMA_HOST,
        port: isCloud ? 443 : OLLAMA_PORT,
        path: req.url,
        method: req.method,
        headers,
        ...(isCloud ? { protocol: 'https:' } : {})
    };

    const proxyReq = (isCloud ? https : http).request(options, (proxyRes) => {
        const label = isCloud ? 'Cloud' : 'Ollama';
        log(`[${label} Response] status=${proxyRes.statusCode} url=${req.url}`);
        if (proxyRes.statusCode >= 400) {
            let errBody = '';
            proxyRes.on('data', chunk => errBody += chunk);
            proxyRes.on('end', () => {
                log(`[${label} Error Body] ${errBody.slice(0, 300)}`);
            });
        }
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        log(`[Proxy Error] ${err.message}`);
        if (!res.headersSent) {
            res.writeHead(502);
            res.end('Proxy Error: Target unreachable');
        }
    });

    if (actualBody) {
        proxyReq.end(actualBody);
    } else {
        req.pipe(proxyReq);
    }
}

// Fetch JSON from a URL
function fetchJson(useHttps, options) {
    return new Promise((resolve, reject) => {
        const req = (useHttps ? https : http).request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error(`JSON parse error: ${body.slice(0, 100)}`)); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// Merge model lists from Anthropic and Ollama
async function getMergedModels(reqHeaders) {
    const cloudHeaders = { ...reqHeaders, host: CLOUD_HOST, 'user-agent': 'claude-code/2.1.100' };
    const [cloudResult, ollamaResult] = await Promise.allSettled([
        fetchJson(true, { hostname: CLOUD_HOST, port: 443, path: '/v1/models', method: 'GET', headers: cloudHeaders, protocol: 'https:' }),
        fetchJson(false, { hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: '/v1/models', method: 'GET', headers: { host: `${OLLAMA_HOST}:${OLLAMA_PORT}` } })
    ]);

    const cloudModels = cloudResult.status === 'fulfilled' ? (cloudResult.value.data || []) : [];
    const ollamaModels = ollamaResult.status === 'fulfilled' ? (ollamaResult.value.data || []) : [];

    if (cloudResult.status === 'rejected') log(`Cloud models failed: ${cloudResult.reason}`);
    if (ollamaResult.status === 'rejected') log(`Ollama models failed: ${ollamaResult.reason}`);

    log(`Models merged: ${cloudModels.length} cloud + ${ollamaModels.length} ollama`);
    return { data: [...cloudModels, ...ollamaModels], has_more: false, object: 'list' };
}

const server = http.createServer(async (req, res) => {
    const mode = getMode();

    // Intercept /v1/models — return merged list
    if (req.url === '/v1/models' && req.method === 'GET') {
        try {
            const merged = await getMergedModels(req.headers);
            const body = JSON.stringify(merged);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
            res.end(body);
        } catch (e) {
            log(`[Merge Error] ${e.message}`);
            res.writeHead(500);
            res.end('Failed to merge model lists');
        }
        return;
    }

    // For requests with a body (POST) — buffer and inspect model name
    if (req.method === 'POST') {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const bodyBuffer = Buffer.concat(chunks);
            let modelName = null;
            let target = mode === 'cloud' ? 'cloud' : 'ollama';

            try {
                const parsed = JSON.parse(bodyBuffer.toString());
                modelName = parsed.model || null;
                target = getTargetForModel(modelName, mode);
            } catch (e) {
                // Non-JSON body — use mode as fallback
            }

            log(`POST ${req.url} | model: ${modelName || 'unknown'} | target: ${target}`);
            forwardTo(target, req, res, bodyBuffer);
        });
        return;
    }

    // All other requests (HEAD, GET, etc.) — route by mode
    const target = mode === 'cloud' ? 'cloud' : 'ollama';
    log(`${req.method} ${req.url} | target: ${target}`);
    forwardTo(target, req, res, null);
});

server.on('error', (err) => {
    log(`[Server Error] ${err.message}`);
});

server.listen(PORT, () => {
    log(`Claude Provider Proxy started on port ${PORT}`);
    log(`Initial mode: ${getMode()}`);
});
