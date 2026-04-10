const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 11436;
const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = process.platform === 'win32' ? 11434 : 11435;
const CLOUD_HOST = 'api.anthropic.com';
const HOME = process.env.HOME || process.env.USERPROFILE;
const MODE_FILE = path.join(HOME, '.claude-provider-proxy', 'mode.txt');
const LOG_FILE = path.join(HOME, '.claude-provider-proxy', 'proxy_internal.log');

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

// Forward request to the specified target
function forwardTo(target, req, res, bodyBuffer) {
    const isCloud = target === 'cloud';
    const headers = { ...req.headers };

    if (isCloud) {
        headers['host'] = CLOUD_HOST;
        headers['user-agent'] = 'claude-code/2.1.100';
    } else {
        headers['host'] = `${OLLAMA_HOST}:${OLLAMA_PORT}`;
    }

    if (bodyBuffer) {
        headers['content-length'] = bodyBuffer.length;
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
        if (proxyRes.statusCode >= 400) {
            let errBody = '';
            proxyRes.on('data', chunk => errBody += chunk);
            proxyRes.on('end', () => {
                log(`[${isCloud ? 'Cloud' : 'Ollama'} Error] ${proxyRes.statusCode} | ${errBody.slice(0, 200)}`);
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

    if (bodyBuffer) {
        proxyReq.end(bodyBuffer);
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
