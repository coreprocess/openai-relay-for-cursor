import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, stat, access } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createRelay } from '../src/app.ts';
import { loadCacheConfig } from '../src/reasoning/config.ts';
import type { RelayConfig } from '../src/config.ts';

const adminRequest = (socketPath: string, path: string, method = 'GET') => new Promise<{status: number; body: Record<string, unknown>}>((resolve, reject) => {
    const req = request({ socketPath, path, method, agent: false }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.once('end', () => { try { resolve({ status: res.statusCode!, body: JSON.parse(body) }); } catch (error) { reject(error); } });
        res.once('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('Test admin request timed out')));
    req.once('error', reject); req.end();
});

test('private admin inspects a running relay and snapshots through the owner connection', { timeout: 15000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-admin-integration-'));
    let requests = 0;
    const upstream = createServer(async (req, res) => {
        requests++;
        if (req.method === 'GET') { res.end(JSON.stringify({ publicPassthrough: true })); return; }
        for await (const _chunk of req) { /* drain fixture request */ }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'r', model: 'test', status: 'completed', output: [
            { type: 'reasoning', id: 'reasoning', encrypted_content: 'synthetic-secret-cipher', summary: [] },
            { type: 'message', id: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PRIVATE_ANSWER' }] },
        ] }));
    });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const config: RelayConfig = {
        cache: { ...loadCacheConfig({}), enabled: true, reserveBytes: 65536, dbPath: join(dir, 'cache.sqlite') },
        adminSocket: relative(process.cwd(), join(dir, 'admin', 'relay.sock')), adminSnapshotDir: join(dir, 'inspection'), host: '127.0.0.1', port: 0,
        relayToken: 'synthetic-token', openAiApiKey: 'synthetic-provider-key', modelPrefix: '', defaultReasoningEffort: 'high',
        ngrokAuthtoken: undefined, ngrokDomain: undefined, logBodies: false, logDir: join(dir, 'logs'),
        upstreamOrigin: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    };
    const relay = createRelay(config);
    try {
        await relay.startAdmin();
        relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
        const origin = `http://127.0.0.1:${(relay.server.address() as { port: number }).port}`;
        const headers = { authorization: 'Bearer synthetic-token', 'content-type': 'application/json' };
        const result = await fetch(`${origin}/v1/chat/completions`, { method: 'POST', headers,
            body: JSON.stringify({ model: 'test', stream: false, messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }] }) });
        assert.equal(result.status, 200); await result.text();
        const status = await adminRequest(config.adminSocket!, '/status');
        assert.equal(status.status, 200);
        assert.equal(status.body.cacheEnabled, true);
        assert.ok(status.body.store);
        for (const secret of ['PRIVATE_PROMPT', 'PRIVATE_ANSWER', 'synthetic-secret-cipher', 'synthetic-provider-key', 'synthetic-token']) {
            assert.equal(JSON.stringify(status.body).includes(secret), false);
        }
        const counters = status.body.counters as { cachedDispatches: number; upstreamResponses: number };
        assert.equal(counters.cachedDispatches, 1); assert.equal(counters.upstreamResponses, 1);
        assert.equal(requests, 1, 'Admin status must not reach upstream');
        const cli = await promisify(execFile)(process.execPath, ['src/reasoning/admin.ts', 'status', '--json',
            '--socket', join(dir, 'admin', 'relay.sock')], { cwd: process.cwd(), env: {}, timeout: 5000 });
        assert.equal(JSON.parse(cli.stdout).cacheEnabled, true, 'CLI works without any API key environment');
        assert.equal((await stat(config.adminSocket!)).mode & 0o777, 0o600);
        const snapshot = await adminRequest(config.adminSocket!, '/snapshot', 'POST');
        assert.equal(snapshot.status, 200);
        const path = String(snapshot.body.path);
        assert.ok(path.startsWith(dir));
        assert.equal((await stat(path)).mode & 0o777, 0o400);
        await assert.rejects(access(`${path}.secret`));
        const copy = new DatabaseSync(path, { readOnly: true });
        assert.equal(copy.prepare('SELECT count(*) n FROM payloads').get()?.n, 1);
        assert.deepEqual(copy.prepare('PRAGMA integrity_check').all(), [{ integrity_check: 'ok' }].map((row) => Object.assign(Object.create(null), row)));
        copy.close();
        const snapshotCli = await promisify(execFile)(process.execPath, ['src/reasoning/admin.ts', 'snapshot', '--json',
            '--socket', join(dir, 'admin', 'relay.sock')], { cwd: process.cwd(), env: {}, timeout: 5000 });
        const secondSnapshot = JSON.parse(snapshotCli.stdout);
        assert.equal(secondSnapshot.inspectionOnly, true);
        assert.notEqual(secondSnapshot.path, path);
        await access(path); // Inspection must not silently delete a previously returned snapshot.
        const ordinary = await fetch(`${origin}/status`, { headers });
        assert.deepEqual(await ordinary.json(), { publicPassthrough: true }, 'Public listener must not expose admin metadata');
        assert.equal(requests, 2);
        await relay.close();
        await assert.rejects(access(config.adminSocket!));
    } finally {
        await relay.close(); upstream.closeAllConnections(); await new Promise<void>((r) => upstream.close(() => r()));
        await rm(dir, { recursive: true, force: true });
    }
});
