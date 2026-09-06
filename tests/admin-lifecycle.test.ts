import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, type DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createRelay } from '../src/app.ts';
import { loadCacheConfig } from '../src/reasoning/config.ts';
import type { RelayConfig } from '../src/config.ts';

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
};

test('ongoing snapshot does not stop model traffic and shutdown waits for its connection lease', { timeout: 10000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'admin-lifecycle-'));
    const upstream = createServer(async (req, res) => {
        for await (const _chunk of req) { /* drain */ }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'r', model: 'test', status: 'completed', output: [
            { type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] },
        ] }));
    });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const config: RelayConfig = {
        adminSnapshotDir: join(dir, 'inspection'),
        cache: { ...loadCacheConfig({}), enabled: true, dbPath: join(dir, 'cache.sqlite'), reserveBytes: 65536 },
        host: '127.0.0.1', port: 0, relayToken: 'test', openAiApiKey: 'test', modelPrefix: '', defaultReasoningEffort: 'high',
        upstreamOrigin: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
        logBodies: false, logDir: join(dir, 'logs'), ngrokAuthtoken: undefined, ngrokDomain: undefined,
    };
    const relay = createRelay(config);
    const entered = deferred(); const release = deferred();
    const store = relay.runtime.store as unknown as { db: DatabaseSync; inspection: { options: { backup?: typeof backup } } };
    store.inspection.options.backup = async (...args) => {
        entered.resolve(); await release.promise;
        return backup(...args);
    };
    relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
    let pending: Promise<unknown> | undefined;
    try {
        pending = relay.runtime.createInspectionSnapshot();
        await entered.promise;
        const response = await fetch(`http://127.0.0.1:${(relay.server.address() as { port: number }).port}/v1/chat/completions`, {
            method: 'POST', headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hello' }], stream: false }),
        });
        assert.equal(response.status, 200); await response.text();
        assert.equal(relay.runtime.inspect().store?.snapshotPending, true);
        let closed = false;
        const stopping = relay.close().then(() => { closed = true; });
        await new Promise<void>((r) => setImmediate(r));
        assert.equal(closed, false);
        assert.equal(store.db.isOpen, true);
        release.resolve();
        await pending; await stopping;
        assert.equal(closed, true); assert.equal(store.db.isOpen, false);
    } finally {
        release.resolve(); await pending?.catch(() => undefined); await relay.close();
        upstream.closeAllConnections(); await new Promise<void>((r) => upstream.close(() => r()));
        await rm(dir, { recursive: true, force: true });
    }
});
