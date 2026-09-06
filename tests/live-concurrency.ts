// Explicit billable opt-in; four synthetic calls, no tunnel, no production configuration loading.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createRelay } from '../src/app.ts';
import { loadCacheConfig } from '../src/reasoning/config.ts';
import type { RelayConfig } from '../src/config.ts';
import { readSseEvents } from '../src/sse.ts';

assert.equal(process.env.ALLOW_BILLABLE_REPLAY_SMOKE, '1');
assert.ok(process.env.REPLAY_SMOKE_KEY_FILE);
const key = parseEnv(await readFile(process.env.REPLAY_SMOKE_KEY_FILE, 'utf8')).OPENAI_API_KEY;
assert.ok(typeof key === 'string' && key.startsWith('sk-'), 'Key missing; not printed');
process.umask(0o077);
const directory = await mkdtemp(join(tmpdir(), 'openai-replay-parallel-'));
const config: RelayConfig = {
    host: '127.0.0.1', port: 0, relayToken: randomUUID(), openAiApiKey: key, upstreamOrigin: 'https://api.openai.com',
    modelPrefix: 'relay-', defaultReasoningEffort: 'high', ngrokAuthtoken: undefined, ngrokDomain: undefined,
    logBodies: true, logDir: join(directory, 'logs'),
    cache: { ...loadCacheConfig({}), enabled: true, dbPath: join(directory, 'cache.sqlite') },
};
const relay = createRelay(config);
relay.server.listen(0, '127.0.0.1');
await once(relay.server, 'listening');
const port = (relay.server.address() as { port: number }).port;
const evidence: Record<string, unknown> = { directory, port, tunnel: false, model: 'gpt-6-astra', rounds: [] };
const call = async (label: string, number: number) => {
    const start = performance.now();
    let firstVisible: number | null = null;
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${config.relayToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'relay-gpt-6-astra-high', stream: true, max_completion_tokens: 2048,
            messages: [{ role: 'user', content: `Synthetic concurrent test ${label}. Calculate (${number} * 17 + 23) * 19. Reply with only the integer, no tools.` }],
            user: `parallel-smoke-${label}` }),
        signal: AbortSignal.timeout(120_000),
    });
    assert.equal(response.status, 200);
    let text = ''; let done = false; let usage: unknown;
    for await (const event of readSseEvents(response.body!)) {
        if (event.data === '[DONE]') { done = true; continue; }
        const frame = JSON.parse(event.data);
        assert.ok(!frame.error, 'Stream must not contain an error');
        usage = frame.usage ?? usage;
        for (const choice of frame.choices ?? []) {
            if (choice.delta?.content) { firstVisible ??= performance.now(); text += choice.delta.content; }
            assert.notEqual(choice.finish_reason, 'length');
        }
    }
    assert.ok(done);
    assert.equal(text.trim(), String((number * 17 + 23) * 19));
    return { label, start, firstVisible, end: performance.now(), status: response.status, text, usage };
};
try {
    for (const limit of [8, 1]) {
        config.cache.maxConcurrent = limit;
        const before = new Set(await readdir(config.logDir).catch(() => [] as string[]));
        const results = await Promise.all([call(`limit${limit}-A`, 137), call(`limit${limit}-B`, 149)]);
        let names: string[] = [];
        for (let attempts = 0; attempts < 100; attempts++) {
            names = (await readdir(config.logDir)).filter((name) => !before.has(name));
            if (names.filter((name) => name.endsWith('4-client-response.sse')).length === 2) break;
            await pause(50);
        }
        const dispatched = await Promise.all(names.filter((name) => name.endsWith('2-upstream-request.json'))
            .map(async (name) => JSON.parse(await readFile(join(config.logDir, name), 'utf8'))));
        assert.equal(dispatched.length, 2);
        const cached = dispatched.filter((body) => body.store === false && body.include?.includes('reasoning.encrypted_content')).length;
        assert.equal(cached, limit === 8 ? 2 : 1);
        assert.ok(Math.max(...results.map((result) => result.start)) < Math.min(...results.map((result) => result.firstVisible!)));
        const round = { limit, concurrentRequests: 2, cached, bypassed: 2 - cached,
            results: results.map(({ label, text, usage, start, firstVisible, end }) => ({ label, text, usage, status: 200,
                durationMs: Math.round(end - start), firstVisibleMs: Math.round(firstVisible! - start) })) };
        (evidence.rounds as unknown[]).push(round);
        console.log(JSON.stringify({ event: 'parallel-round', ...round }));
    }
    evidence.passed = true;
} catch (error) {
    evidence.failure = error instanceof Error ? error.message : 'Live concurrent smoke failed';
    process.exitCode = 1;
} finally {
    await relay.close();
    const db = new DatabaseSync(config.cache.dbPath, { readOnly: true });
    evidence.database = { unresolved: db.prepare('SELECT count(*) count FROM intents').get()?.count,
        markers: db.prepare('SELECT kind,count(*) count FROM markers GROUP BY kind').all() };
    db.close();
    evidence.testRelayStopped = true;
    await writeFile(join(directory, 'summary.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ event: 'parallel-summary', ...evidence }));
}
