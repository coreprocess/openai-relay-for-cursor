import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRelay } from '../src/app.ts';
import type { RelayConfig } from '../src/config.ts';
import { loadCacheConfig } from '../src/reasoning/config.ts';

test('disabled installation does not create store; health/auth/models and direct Responses remain compatible', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-compat-'));
    const requests: { path: string; body: string }[] = [];
    const upstream = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        requests.push({ path: req.url!, body: Buffer.concat(chunks).toString() });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ unchanged: true }));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const config: RelayConfig = {
        cache: { ...loadCacheConfig({}), dbPath: join(directory, 'never.sqlite') }, host: '127.0.0.1', port: 0,
        relayToken: 'token', openAiApiKey: 'fake', upstreamOrigin: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
        modelPrefix: 'relay-', defaultReasoningEffort: 'high', ngrokAuthtoken: undefined, ngrokDomain: undefined,
        logBodies: false, logDir: join(directory, 'logs'),
    };
    const relay = createRelay(config);
    relay.server.listen(0, '127.0.0.1');
    await once(relay.server, 'listening');
    const origin = `http://127.0.0.1:${(relay.server.address() as { port: number }).port}`;
    try {
        assert.equal((await fetch(`${origin}/health`)).status, 200);
        assert.equal((await fetch(`${origin}/v1/models`)).status, 401);
        assert.equal(requests.length, 0);
        const headers = { authorization: 'Bearer token', 'content-type': 'application/json' };
        assert.deepEqual(await (await fetch(`${origin}/v1/models`, { headers })).json(), { unchanged: true });
        const body = { model: 'test', input: 'hello', store: true };
        assert.deepEqual(await (await fetch(`${origin}/v1/responses`, { method: 'POST', headers, body: JSON.stringify(body) })).json(), { unchanged: true });
        assert.deepEqual(JSON.parse(requests[1]!.body), body);
        assert.equal(existsSync(config.cache.dbPath), false);
        assert.equal(existsSync(`${config.cache.dbPath}.secret`), false);
    } finally {
        await relay.close();
        upstream.closeAllConnections();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
        rmSync(directory, { recursive: true, force: true });
    }
});
