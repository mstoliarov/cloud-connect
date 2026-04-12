const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || process.env.USERPROFILE;
const DATA_DIR = path.join(HOME, '.claude-provider-proxy');
const PORT = 11436;
const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const OLLAMA_PORT = parseInt(process.env.OLLAMA_PORT || '11434', 10);
const CLOUD_HOST = 'api.anthropic.com';
const MODE_FILE = path.join(DATA_DIR, 'mode.txt');
const LOG_FILE = path.join(DATA_DIR, 'proxy.log');
const CREDENTIALS_FILE = path.join(HOME, '.claude', '.credentials.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(MODE_FILE)) fs.writeFileSync(MODE_FILE, 'ollama');

function log(message) {
    const msg = `[${new Date().toISOString()}] ${message}\n`;
    process.stdout.write(msg);
    fs.appendFileSync(LOG_FILE, msg);
}

// Try credentials.json first, then fall back to env variable
function getApiKey() {
    const envKey = process.env.ANTHROPIC_API_KEY;
    if (envKey) return envKey;
    try {
        const creds = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
        return creds?.claudeAiOauth?.accessToken || null;
    } catch (e) {
        log(`Warning: could not read credentials: ${e.message}`);
        return null;
    }
}

function getMode() {
    try {
        return fs.readFileSync(MODE_FILE, 'utf8').trim().toLowerCase();
    } catch (e) {
        return 'ollama';
    }
}

function getTargetForModel(modelName, mode) {
    if (!modelName) return mode === 'cloud' ? 'cloud' : 'ollama';
    if (modelName.startsWith('claude-')) return 'cloud';
    return 'ollama';
}

function sanitizeForOllama(bodyBuffer) {
    try {
        const parsed = JSON.parse(bodyBuffer.toString());
        let modified = false;

        if (parsed.thinking) {
            delete parsed.thinking;
            modified = true;
        }

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

function forwardTo(target, req, res, bodyBuffer) {
    const isCloud = target === 'cloud';
    let headers = { ...req.headers };
    let actualBody = bodyBuffer;

    if (isCloud) {
        headers['host'] = CLOUD_HOST;
        headers['user-agent'] = 'claude-code/2.1.100';
        const apiKey = getApiKey();
        if (apiKey) headers['x-api-key'] = apiKey;
    } else {
        headers['host'] = `${OLLAMA_HOST}:${OLLAMA_PORT}`;
        headers['authorization'] = 'Bearer ollama';
        if (actualBody) actualBody = sanitizeForOllama(actualBody);
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

async function getMergedModels(reqHeaders) {
    const apiKey = getApiKey();
    const cloudHeaders = {
        ...reqHeaders,
        host: CLOUD_HOST,
        'user-agent': 'claude-code/2.1.100',
        ...(apiKey ? { 'x-api-key': apiKey } : {})
    };

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

    const target = mode === 'cloud' ? 'cloud' : 'ollama';
    log(`${req.method} ${req.url} | target: ${target}`);
    forwardTo(target, req, res, null);
});

server.on('error', (err) => {
    log(`[Server Error] ${err.message}`);
});

server.listen(PORT, () => {
    log(`Cloud-Connect Proxy (Windows/native) started on port ${PORT}`);
    log(`Ollama: ${OLLAMA_HOST}:${OLLAMA_PORT} | Mode: ${getMode()}`);
});
