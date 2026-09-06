import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createRelay } from '../src/app.ts';
import { loadCacheConfig } from '../src/reasoning/config.ts';
import type { RelayConfig } from '../src/config.ts';

test('malformed generation requests fail as client errors without touching upstream', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'relay-http-boundaries-'));
    let upstreamCalls = 0;
    const upstream = createServer((_req, res) => { upstreamCalls++; res.end('{"output":[]}'); });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const config: RelayConfig = {
        host: '127.0.0.1', port: 0, relayToken: 'synthetic', openAiApiKey: 'synthetic', modelPrefix: 'relay-',
        defaultReasoningEffort: 'high', upstreamOrigin: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
        logBodies: false, logDir: join(directory, 'logs'), ngrokAuthtoken: undefined, ngrokDomain: undefined,
        cache: { ...loadCacheConfig({}), dbPath: join(directory, 'unused.sqlite') },
    };
    const relay = createRelay(config); relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
    try {
        for (const body of ['{', 'null', '[]', JSON.stringify({ model: 'test', messages: [null] }),
            JSON.stringify({ model: 'test', messages: [{ role: 'assistant', content: 7 }] }),
            JSON.stringify({ model: 'test', messages: [{ role: 'assistant', tool_calls: 'oops' }] }),
            JSON.stringify({ model: 'test', messages: [{ role: 'user', content: [null] }] }),
            JSON.stringify({ model: 'test', messages: 'not-an-array' })]) {
            const response = await fetch(`http://127.0.0.1:${(relay.server.address() as { port: number }).port}/v1/chat/completions`, {
                method: 'POST', headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' }, body,
            });
            assert.equal(response.status, 400, body);
            assert.ok((await response.json() as { error?: unknown }).error);
        }
        assert.equal(upstreamCalls, 0);
    } finally {
        await relay.close(); upstream.closeAllConnections(); await new Promise<void>((r) => upstream.close(() => r()));
        await rm(directory, { recursive: true, force: true });
    }
});
