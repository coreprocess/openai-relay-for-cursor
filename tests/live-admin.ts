// Manual billable opt-in. Five real calls through a test-owned relay; never starts ngrok.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv, promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createRelay } from '../src/app.ts';
import { requestAdmin } from '../src/admin/client.ts';
import { loadCacheConfig } from '../src/reasoning/config.ts';
import type { RelayConfig } from '../src/config.ts';
import type { JsonBody } from '../src/http.ts';
import type { InspectionSnapshot } from '../src/reasoning/inspection.ts';
import { readSseEvents } from '../src/sse.ts';

type Status = ReturnType<ReturnType<typeof createRelay>['runtime']['inspect']>;
assert.equal(process.env.ALLOW_BILLABLE_REPLAY_SMOKE, '1', 'Explicit live-test opt-in required');
assert.ok(process.env.REPLAY_SMOKE_KEY_FILE, 'Explicit key source required');
const key = parseEnv(await readFile(process.env.REPLAY_SMOKE_KEY_FILE, 'utf8')).OPENAI_API_KEY;
assert.ok(typeof key === 'string' && key.startsWith('sk-'), 'Key missing; not printed');
process.umask(0o077);
const directory = await mkdtemp(join(tmpdir(), 'relay-admin-live-'));
const config: RelayConfig = {
    cache: { ...loadCacheConfig({}), enabled: true, dbPath: join(directory, 'cache.sqlite') },
    adminSocket: join(directory, 'admin', 'relay.sock'), adminSnapshotDir: join(directory, 'inspection'),
    host: '127.0.0.1', port: 0, relayToken: randomUUID(), openAiApiKey: key,
    upstreamOrigin: 'https://api.openai.com', modelPrefix: 'relay-', defaultReasoningEffort: 'high',
    ngrokAuthtoken: undefined, ngrokDomain: undefined, logBodies: true, logDir: join(directory, 'logs'),
};
const relay = createRelay(config);
const suiteAbort = new AbortController();
const pending = new Set<Promise<unknown>>();
let calls = 0;
const cases: JsonBody[] = [];
const evidence: JsonBody = { directory, model: 'gpt-6-astra', effort: 'high', maximumCalls: 5, tunnel: false, cases };
const check = async (name: string, action: () => unknown | Promise<unknown>) => {
    const details = await action();
    cases.push({ name, status: 'pass', ...(details && typeof details === 'object' ? details : {}) });
    console.log(JSON.stringify(cases.at(-1)));
};
const admin = async (): Promise<Status> => {
    const status = await requestAdmin(config.adminSocket!, 'status') as Status;
    const text = JSON.stringify(status);
    assert.equal(text.includes(key), false);
    assert.equal(text.includes(config.relayToken), false);
    assert.equal(text.includes('SYNTHETIC_PRIVATE_INVOICE'), false);
    assert.equal(text.includes('encrypted_content'), false);
    return status;
};
const cli = async (command: 'status' | 'snapshot') => {
    const result = await promisify(execFile)(process.execPath, ['src/reasoning/admin.ts', command, '--json', '--socket', config.adminSocket!],
        { cwd: process.cwd(), env: {}, timeout: command === 'status' ? 5000 : 30000, maxBuffer: 1024 * 1024 });
    return JSON.parse(result.stdout);
};
const waitIdle = async () => {
    for (let i = 0; i < 200; i++) {
        if ((await admin()).activeCachedSessions === 0) return;
        await pause(25);
    }
    throw new Error('Test sessions did not finish');
};
// Test-created store only. Inspect raw state in-memory to prove admin reads do not mutate it.
const sourceDb = () => (relay.runtime.store as unknown as { db: DatabaseSync }).db;
const fingerprintSource = () => {
    const db = sourceDb();
    const tables = ['metadata', 'scopes', 'snapshots', 'observations', 'payloads', 'markers', 'dependencies', 'intents', 'intent_dependencies'];
    return createHash('sha256').update(JSON.stringify(tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))).digest('hex');
};
const artifacts = async (tag: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
        const names = await readdir(config.logDir);
        for (const name of names.filter((name) => name.endsWith('0-client-headers.json'))) {
            const h = JSON.parse(await readFile(join(config.logDir, name), 'utf8'));
            if (h['x-test-case'] !== tag) continue;
            const prefix = name.slice(0, -'0-client-headers.json'.length);
            const upstreamName = names.find((n) => n.startsWith(prefix) && /3-upstream-response\.(json|sse)$/.test(n));
            if (!upstreamName) continue;
            const wire = JSON.parse(await readFile(join(config.logDir, `${prefix}2-upstream-request.json`), 'utf8')) as JsonBody;
            const raw = await readFile(join(config.logDir, upstreamName), 'utf8');
            let response: JsonBody | undefined;
            if (upstreamName.endsWith('.json')) response = JSON.parse(raw);
            else {
                async function* chunks() { yield Buffer.from(raw); }
                for await (const event of readSseEvents(chunks())) {
                    const parsed = JSON.parse(event.data);
                    if (parsed.type === 'response.completed') response = parsed.response;
                }
            }
            assert.equal(response?.status, 'completed');
            return { wire, output: response!.output as JsonBody[] };
        }
        await pause(50);
    }
    throw new Error('Test diagnostic artifacts missing or incomplete');
};
let origin = '';
const call = (tag: string, messages: JsonBody[], caller: string, stream: boolean) => {
    assert.ok(++calls <= 5, 'No automatic extra model calls');
    const task = (async () => {
        const start = performance.now();
        const response = await fetch(`${origin}/v1/chat/completions`, {
            method: 'POST', headers: { authorization: `Bearer ${config.relayToken}`, 'content-type': 'application/json', 'x-test-case': tag },
            body: JSON.stringify({ model: 'relay-gpt-6-astra-high', messages, user: caller, stream, max_completion_tokens: 4096 }),
            signal: AbortSignal.any([suiteAbort.signal, AbortSignal.timeout(120000)]),
        });
        assert.equal(response.status, 200, 'Real provider call must succeed');
        let text = ''; let usage: unknown; let done = !stream; let finish: string | undefined; let chunks = 0;
        if (stream) {
            for await (const event of readSseEvents(response.body!)) {
                if (event.data === '[DONE]') { done = true; continue; }
                const data = JSON.parse(event.data); assert.ok(!data.error, 'No stream error'); usage = data.usage ?? usage;
                for (const choice of data.choices ?? []) {
                    if (choice.delta?.content) { text += choice.delta.content; chunks++; }
                    finish = choice.finish_reason ?? finish;
                }
            }
        } else {
            const data = await response.json() as { choices: Array<{ message: {content: string}; finish_reason: string }>; usage?: unknown };
            text = data.choices[0]!.message.content; finish = data.choices[0]!.finish_reason; usage = data.usage;
        }
        assert.equal(finish, 'stop'); assert.equal(done, true);
        const { wire, output } = await artifacts(tag);
        const result = { tag, text, stream, chunks, elapsedMs: Math.round(performance.now() - start), usage,
            encryptedInputItems: (wire.input as JsonBody[]).filter((x) => x.type === 'reasoning' && x.encrypted_content).length,
            encryptedOutputItems: output.filter((x) => x.type === 'reasoning' && x.encrypted_content).length };
        console.log(JSON.stringify({ event: 'live-response', ...result }));
        const envelope: JsonBody = { role: 'assistant', content: [{ type: 'text', text }] };
        return { ...result, wire, output, envelope };
    })();
    pending.add(task); void task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
};
const contains = (wire: JsonBody, block: JsonBody[]) => {
    const input = wire.input as JsonBody[];
    return input.some((_, i) => JSON.stringify(input.slice(i, i + block.length)) === JSON.stringify(block));
};
const inspectCopy = async (snapshot: InspectionSnapshot) => {
    assert.equal(snapshot.inspectionOnly, true);
    assert.ok(resolve(snapshot.path).startsWith(resolve(config.adminSnapshotDir!) + '/'));
    const permissions = (await stat(snapshot.path)).mode & 0o777;
    assert.equal(permissions, 0o400);
    await assert.rejects(access(`${snapshot.path}.secret`));
    const directoryEntries = await readdir(join(snapshot.path, '..'));
    assert.equal(directoryEntries.some((name) => name.includes('secret')), false);
    const db = new DatabaseSync(`file:${snapshot.path}?immutable=1`, { readOnly: true });
    try {
        assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
        assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
        const counts = db.prepare('SELECT (SELECT count(*) FROM payloads) payloads, (SELECT count(*) FROM intents) intents').get()!;
        assert.ok(Number(counts.payloads) >= 1);
        return { bytes: snapshot.bytes, pages: snapshot.pages, permissions: permissions.toString(8), ...counts };
    } finally { db.close(); }
};

try {
    await relay.startAdmin(); relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
    const port = (relay.server.address() as { port: number }).port;
    evidence.port = port; origin = `http://127.0.0.1:${port}`;
    console.log(JSON.stringify({ event: 'isolated-admin-live-start', port, directory, tunnel: false }));
    const base: JsonBody[] = [{ role: 'system', content: 'Compute synthetic invoices. Show concise final calculations, not private reasoning.' },
        { role: 'user', content: 'SYNTHETIC_PRIVATE_INVOICE: 3 items at 120 EUR and 2 at 80 EUR. Discount goods 10%, add 15 EUR shipping, then add VAT 19%. Calculate the gross total.' }];
    const seed = await call('seed', base, 'admin-live-A', true);
    assert.match(seed.text, /574[.,]77/); assert.ok(seed.encryptedOutputItems > 0, 'Need real encrypted output to verify replay');
    await waitIdle();
    await check('status reads including refresh leave all source rows and eligibility unchanged', async () => {
        const before = fingerprintSource();
        const totalChanges = sourceDb().prepare('SELECT total_changes() n').get()?.n;
        const retention = relay.runtime.inspect().store!.retention;
        for (let i = 0; i < 3; i++) await admin();
        await pause(5100); // Deliberately cross the cached-metrics TTL; no LLM request is active.
        const fromCli = await cli('status') as Status;
        assert.equal(fromCli.store?.metrics?.counts.payloads.value, 1);
        assert.equal(fingerprintSource(), before);
        assert.equal(sourceDb().prepare('SELECT total_changes() n').get()?.n, totalChanges);
        assert.deepEqual(relay.runtime.inspect().store!.retention, retention);
        return { repeatedReads: 4, refreshedMetrics: true, sourceUnchanged: true };
    });
    const aHistory: JsonBody[] = [...base, seed.envelope, { role: 'user', content: 'Change only the goods discount to 15%. Calculate the new gross total and gross savings.' }];
    const bHistory: JsonBody[] = [{ role: 'user', content: 'Calculate (137 * 173 + 251) * 197. Return only the integer.' }];
    const a = call('concurrent-A', aHistory, 'admin-live-A', false);
    const b = call('concurrent-B', bHistory, 'admin-live-B', true);
    let active: Status | undefined;
    for (let i = 0; i < 100; i++) {
        active = await admin(); if (active.activeCachedSessions >= 2) break;
        await pause(10);
    }
    assert.ok(active && active.activeCachedSessions >= 2, 'Two real generations must overlap before snapshot');
    let firstSnapshot: InspectionSnapshot | undefined;
    await check('snapshot completes while real generations remain active', async () => {
        const start = performance.now();
        firstSnapshot = await cli('snapshot') as InspectionSnapshot;
        const after = await admin();
        assert.ok(after.activeCachedSessions > 0, 'Snapshot must overlap ongoing real generation');
        return { activeBefore: active!.activeCachedSessions, activeAfter: after.activeCachedSessions,
            durationMs: Math.round(performance.now() - start), snapshot: await inspectCopy(firstSnapshot) };
    });
    const [firstA, firstB] = await Promise.all([a, b]);
    assert.match(firstA.text, /543[.,]83/); assert.equal(firstB.text.trim(), '4718544');
    assert.ok(contains(firstA.wire, seed.output), 'Original encrypted seed block must survive admin activity');
    await check('concurrent model calls complete with expected answers and exact replay', () => ({
        responses: [firstA, firstB].map(({ tag, elapsedMs, encryptedInputItems, encryptedOutputItems, usage }) => ({
            tag, elapsedMs, encryptedInputItems, encryptedOutputItems, usage })),
    }));
    const [nextA, nextB] = await Promise.all([
        call('followup-A', [...aHistory, firstA.envelope, { role: 'user', content: 'Repeat the original total, revised total and savings in one sentence.' }], 'admin-live-A', true),
        call('followup-B', [...bHistory, firstB.envelope, { role: 'user', content: 'Add 7 and output only the new integer.' }], 'admin-live-B', false),
    ]);
    assert.match(nextA.text, /30[.,]94/); assert.equal(nextB.text.trim(), '4718551');
    await check('later requests continue verified replay after snapshot', () => {
        assert.ok(contains(nextA.wire, seed.output));
        if (firstA.encryptedOutputItems > 0) assert.ok(contains(nextA.wire, firstA.output));
        if (firstB.encryptedOutputItems > 0) assert.ok(contains(nextB.wire, firstB.output));
        return { replayedA: nextA.encryptedInputItems, replayedB: nextB.encryptedInputItems };
    });
    await waitIdle();
    await check('snapshot reads also leave idle source state untouched and preserve prior export', async () => {
        const before = fingerprintSource(); const changes = sourceDb().prepare('SELECT total_changes() n').get()?.n;
        const snapshot = await requestAdmin(config.adminSocket!, 'snapshot') as InspectionSnapshot;
        assert.equal(fingerprintSource(), before); assert.equal(sourceDb().prepare('SELECT total_changes() n').get()?.n, changes);
        assert.ok(firstSnapshot); await access(firstSnapshot.path);
        return { sourceUnchanged: true, earlierSnapshotPreserved: true, snapshot: await inspectCopy(snapshot) };
    });
    await check('admin routes are not exposed without authentication on public listener', async () => {
        assert.equal((await fetch(`${origin}/status`)).status, 401);
        assert.equal((await fetch(`${origin}/snapshot`, { method: 'POST' })).status, 401);
        return { noAdminDataOnPublicListener: true };
    });
    const final = await admin();
    assert.equal(final.activeCachedSessions, 0); assert.equal(sourceDb().prepare('SELECT count(*) n FROM intents').get()?.n, 0);
    evidence.finalStatus = final;
    evidence.passed = true;
} catch (error) {
    evidence.passed = false; evidence.failure = error instanceof Error ? error.message : 'Acceptance failed';
    process.exitCode = 1;
} finally {
    suiteAbort.abort();
    await Promise.allSettled([...pending]);
    await relay.close();
    evidence.billableRequestsAttempted = calls;
    evidence.testRelayStopped = true;
    try { await access(config.adminSocket!); evidence.adminSocketRemoved = false; process.exitCode = 1; }
    catch { evidence.adminSocketRemoved = true; }
    await writeFile(join(directory, 'summary.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ event: 'admin-live-summary', ...evidence }));
}
