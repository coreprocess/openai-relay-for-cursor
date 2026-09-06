import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ReplayRuntime } from '../src/reasoning/runtime.ts';
import { loadCacheConfig } from '../src/reasoning/config.ts';
import type { RelayConfig } from '../src/config.ts';

test('status is metadata only and works without creating a disabled cache', () => {
    const dir = mkdtempSync(join(tmpdir(), 'admin-disabled-'));
    const config: RelayConfig = {
        cache: { ...loadCacheConfig({}), dbPath: join(dir, 'cache.sqlite') }, host: '127.0.0.1', port: 0,
        relayToken: 'private-token', openAiApiKey: 'private-key', modelPrefix: 'relay-', defaultReasoningEffort: 'high',
        upstreamOrigin: 'https://example.invalid', ngrokAuthtoken: undefined, ngrokDomain: undefined,
        logBodies: false, logDir: join(dir, 'logs'),
    };
    const runtime = new ReplayRuntime(config);
    try {
        const status = runtime.inspect();
        assert.equal(status.cacheEnabled, false); assert.equal(status.store, null);
        assert.equal(status.counters.cachedDispatches, 0);
        assert.equal(status.counters.upstreamResponses, 0);
        assert.equal(status.activeCachedSessions, 0);
        assert.equal(existsSync(config.cache.dbPath), false);
        assert.equal(JSON.stringify(status).includes('private'), false);
        assert.throws(() => runtime.createInspectionSnapshot(), /unavailable/);
    } finally { runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});
