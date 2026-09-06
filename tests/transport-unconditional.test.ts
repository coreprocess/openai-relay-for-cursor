import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { createRelay } from '../src/app.ts';
import { loadCacheConfig } from '../src/reasoning/config.ts';
import type { RelayConfig } from '../src/config.ts';

const fixture = async (t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void, enabled = false) => {
    const directory = await mkdtemp(join(tmpdir(), 'relay-unconditional-'));
    const upstream = createServer(handler); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const config: RelayConfig = {
        cache: { ...loadCacheConfig({}), enabled, dbPath: join(directory, 'cache.sqlite'), reserveBytes: 1 },
        transport: { idleTimeoutMs: 120, deliveryTimeoutMs: 120, maxRequestBytes: 2048, maxResponseBytes: 1024, maxSseEventBytes: 1024 },
        host: '127.0.0.1', port: 0, relayToken: 'test', openAiApiKey: 'test', modelPrefix: '', defaultReasoningEffort: 'high',
        ngrokAuthtoken: undefined, ngrokDomain: undefined, logBodies: false, logDir: join(directory, 'logs'),
        upstreamOrigin: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    };
    const relay = createRelay(config); relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
    t.after(async () => {
        await relay.close(); upstream.closeAllConnections(); await new Promise<void>((r) => upstream.close(() => r()));
        await rm(directory, { recursive: true, force: true });
    });
    return { config, relay, url: `http://127.0.0.1:${(relay.server.address() as { port: number }).port}`,
        headers: { authorization: 'Bearer test', 'content-type': 'application/json' } };
};
const body = JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'test' }], stream: true });

test('unwritable diagnostic path cannot fail an otherwise valid model reply', { timeout: 3000 }, async (t) => {
    const app = await fixture(t, (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'r', model: 'test', status: 'completed', output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] },
        ] }));
    });
    await writeFile(app.config.logDir, 'block diagnostic directory');
    app.config.logBodies = true;
    const response = await fetch(`${app.url}/v1/chat/completions`, { method: 'POST', headers: app.headers,
        body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hello' }], stream: false }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content, 'OK');
});

for (const method of ['GET', 'HEAD']) test(`bodyless ${method} passthrough completes instead of waiting forever`, { timeout: 2000 }, async (t) => {
    const app = await fixture(t, (_req, res) => { res.writeHead(204); res.end(); });
    const response = await fetch(`${app.url}/v1/models`, { method, headers: app.headers, signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 204); assert.equal(await response.text(), '');
});

for (const mode of ['disabled', 'capacity', 'direct', 'identity-limit'] as const) test(`uncached ${mode} requests still have relay-owned deadlines`, { timeout: 3000 }, async (t) => {
    const app = await fixture(t, () => {}, mode !== 'disabled');
    if (mode === 'capacity') app.config.cache.maxConcurrent = 0;
    if (mode === 'identity-limit') app.config.cache.limits.maxMessages = 0;
    const started = performance.now();
    await assert.rejects(fetch(`${app.url}/${mode === 'direct' ? 'v1/responses' : 'v1/chat/completions'}`, {
        method: 'POST', headers: app.headers, body: mode === 'direct' ? JSON.stringify({ model: 'test', input: 'test' }) : body,
        signal: AbortSignal.timeout(1500),
    }));
    assert.ok(performance.now() - started < 1000);
    await pause(20);
});

test('post-terminal SSE is never forwarded even with cache disabled', { timeout: 2000 }, async (t) => {
    const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
    const app = await fixture(t, (_req, res) => {
        res.setHeader('content-type', 'text/event-stream');
        res.end(frame({ type: 'response.created', response: { id: 'r', model: 'test' } }) +
            frame({ type: 'response.completed', response: { id: 'r', model: 'test', status: 'completed', output: [] } }) +
            frame({ type: 'response.output_text.delta', delta: 'AFTER_DONE' }));
    });
    const response = await fetch(`${app.url}/v1/chat/completions`, { method: 'POST', headers: app.headers, body });
    const text = await response.text(); assert.equal(text.includes('AFTER_DONE'), false);
    assert.equal(text.split('[DONE]').length, 2);
});

test('oversized upload is rejected locally before upstream dispatch', { timeout: 2000 }, async (t) => {
    let called = false;
    const app = await fixture(t, (_req, res) => { called = true; res.end(); });
    const response = await fetch(`${app.url}/v1/chat/completions`, { method: 'POST', headers: app.headers, body: 'x'.repeat(4096) });
    assert.equal(response.status, 413); assert.equal(called, false);
});

for (const kind of ['sse', 'json', 'error'] as const) test(`oversized ${kind} upstream response terminates deliberately`, { timeout: 2000 }, async (t) => {
    const app = await fixture(t, (_req, res) => {
        res.writeHead(kind === 'error' ? 500 : 200, { 'content-type': kind === 'sse' ? 'text/event-stream' : 'application/json' });
        res.end(kind === 'sse' ? `data: ${'x'.repeat(4096)}` : JSON.stringify({ message: 'x'.repeat(4096) }));
    });
    const response = await fetch(`${app.url}/v1/chat/completions`, { method: 'POST', headers: app.headers,
        body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'test' }], stream: kind === 'sse' }) });
    if (kind === 'sse') await assert.rejects(response.text());
    else { assert.equal(response.status, 502); assert.ok((await response.json() as { error?: unknown }).error); }
});
