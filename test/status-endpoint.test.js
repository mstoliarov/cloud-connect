const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { spawn } = require('node:child_process');
const path = require('node:path');

let proxyProc;
const TEST_PORT = 11499;

function getJson(port, url) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${url}`, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
                catch (e) { reject(new Error(`JSON parse: ${body}`)); }
            });
        }).on('error', reject);
    });
}

before(async () => {
    proxyProc = spawn('node', [path.join(__dirname, '..', 'proxy.js')], {
        env: { ...process.env, CLAUDE_PROXY_PORT: String(TEST_PORT) },
        stdio: ['ignore', 'ignore', 'ignore'],
    });
    // wait for listen
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 100));
        try {
            await getJson(TEST_PORT, '/status');
            return;
        } catch (e) { /* not ready */ }
    }
    throw new Error('proxy did not start');
});

after(() => {
    if (proxyProc) proxyProc.kill();
});

test('GET /status returns JSON even before any request', async () => {
    const { status, body } = await getJson(TEST_PORT, '/status');
    assert.strictEqual(status, 200);
    assert.ok(body.provider);
    assert.ok(body.generated_at);
});

test('GET /status: provider defaults to ollama when no request seen', async () => {
    const { body } = await getJson(TEST_PORT, '/status');
    assert.strictEqual(body.provider.id, 'ollama');
    assert.strictEqual(body.provider.icon, '⚪');
});

test('GET /status includes usage object with short and long keys', async () => {
    const { body } = await getJson(TEST_PORT, '/status');
    assert.ok('usage' in body);
    assert.ok('short' in body.usage);
    assert.ok('long' in body.usage);
});
