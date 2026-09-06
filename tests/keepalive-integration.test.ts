import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createRelay } from '../src/app.ts';
import type { RelayConfig } from '../src/config.ts';
import type { JsonBody } from '../src/http.ts';
import { loadCacheConfig } from '../src/reasoning/config.ts';

const options = { concurrency: false, timeout: 2_000 };
const history = [{ role: 'user', content: 'Synthetic keepalive request' }];
const answer = 'Synthetic completed answer.';
const output = [
    { type: 'reasoning', id: 'keepalive-reasoning', summary: [], encrypted_content: 'synthetic-keepalive-ciphertext' },
    { type: 'message', id: 'keepalive-message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: answer, annotations: [] }] },
];
type Outcome = { status: number | null; body: string; complete: boolean; idleExpired: boolean };
type Exchange = { body: JsonBody; res: ServerResponse; closed: Promise<void>; startedAt: number;
    closedAt?: number; completed: boolean; nativeEvents: number; reasoningEvents: number };

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((complete) => { resolve = complete; });
    return { promise, resolve };
};
const beforeDeadline = async <T>(pending: Promise<T>, label: string, ms = 650): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([pending, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Semantic deadline: ${label} (${ms}ms)`)), ms);
        })]);
    } finally { clearTimeout(timer); }
};
const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
    const deadline = performance.now() + 350;
    while (!predicate() && performance.now() < deadline) await delay(5);
    assert.ok(predicate(), label);
};
const parseFrames = (body: string) => {
    const blocks = body.replace(/\r\n/g, '\n').split('\n\n').filter(Boolean);
    const comments = blocks.filter((block) => block.split('\n').every((line) => line.startsWith(':')));
    const data = blocks.filter((block) => !comments.includes(block)).map((block) => {
        assert.ok(block.startsWith('data: '), `unexpected SSE frame: ${block}`);
        return block.slice(6);
    });
    return { comments, data };
};
const assertCompleted = (result: Outcome) => {
    assert.equal(result.status, 200);
    assert.equal(result.complete, true, JSON.stringify(result));
    assert.equal(result.idleExpired, false, 'the downstream idle deadline must not expire');
    const frames = parseFrames(result.body);
    assert.equal(frames.data.length, 5, 'only role, text, finish, usage, and DONE data frames');
    assert.equal(frames.data.filter((frame) => frame === '[DONE]').length, 1);
    assert.equal(frames.data.at(-1), '[DONE]');
    const events = frames.data.slice(0, -1).map((frame) => JSON.parse(frame));
    assert.ok(events.every((event) => event.object === 'chat.completion.chunk'));
    const choices = events.flatMap((event) => event.choices);
    assert.equal(choices.map((choice) => choice.delta?.content ?? '').join(''), answer);
    assert.deepEqual(choices.map((choice) => choice.finish_reason).filter(Boolean), ['stop']);
    assert.equal(result.body.includes('synthetic-keepalive-ciphertext'), false);
    assert.equal(result.body.includes('synthetic-hidden-reasoning'), false);
    return frames;
};

/** All listeners, credentials, storage, clients, and fixture timers belong to this test. */
const fixture = async (t: TestContext, settings: {
    enabled: boolean; sseKeepaliveMs: number; idleTimeoutMs?: number; silent?: boolean;
}) => {
    const directory = await mkdtemp(join(tmpdir(), 'relay-keepalive-integration-'));
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const clients = new Set<ReturnType<typeof request>>();
    const handlers = new Set<Promise<void>>();
    const outcomes: Promise<Outcome>[] = [];
    const handlerErrors: unknown[] = [];
    const received: Exchange[] = [];
    let relay: ReturnType<typeof createRelay> | undefined;
    const upstream = createServer((req, res) => {
        const pending = (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            assert.equal(req.url, '/v1/responses');
            assert.equal(req.headers.authorization, 'Bearer synthetic-keepalive-upstream-key');
            const closed = deferred<void>();
            const exchange: Exchange = { body: JSON.parse(Buffer.concat(chunks).toString()), res,
                closed: closed.promise, startedAt: performance.now(), completed: false, nativeEvents: 0, reasoningEvents: 0 };
            let reasoningTimer: ReturnType<typeof setInterval> | undefined;
            let completionTimer: ReturnType<typeof setTimeout> | undefined;
            const clearTimers = () => {
                for (const timer of [reasoningTimer, completionTimer]) {
                    if (timer) { clearTimeout(timer); timers.delete(timer); }
                }
            };
            res.once('close', () => { clearTimers(); exchange.closedAt = performance.now(); closed.resolve(); });
            received.push(exchange);
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.flushHeaders();
            if (settings.silent) return; // Headers only: no upstream body bytes, including no response.created.
            const emit = (event: unknown) => { exchange.nativeEvents++; res.write(`data: ${JSON.stringify(event)}\n\n`); };
            const response = { id: 'keepalive-response', model: 'keepalive-model', status: 'completed', output };
            emit({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
            const complete = () => {
                clearTimers();
                exchange.completed = true;
                emit({ type: 'response.output_text.delta', delta: answer });
                output.forEach((item, output_index) => emit({ type: 'response.output_item.done', output_index, item }));
                emit({ type: 'response.completed', response });
                res.end();
            };
            if (received.length > 1) { complete(); return; }
            reasoningTimer = setInterval(() => {
                exchange.reasoningEvents++;
                emit({ type: 'response.reasoning_summary_text.delta', item_id: 'keepalive-reasoning',
                    output_index: 0, summary_index: 0, delta: 'synthetic-hidden-reasoning' });
            }, 20);
            completionTimer = setTimeout(complete, 250);
            timers.add(reasoningTimer); timers.add(completionTimer);
        })().catch((error: unknown) => { handlerErrors.push(error); res.destroy(); });
        handlers.add(pending);
        void pending.then(() => handlers.delete(pending));
    });
    t.after(async () => {
        for (const timer of timers) clearTimeout(timer);
        for (const client of clients) client.destroy();
        try { await relay?.close(); }
        finally {
            const stopped = upstream.listening ? new Promise<void>((resolve, reject) => {
                upstream.close((error) => error ? reject(error) : resolve());
                upstream.closeAllConnections();
            }) : Promise.resolve();
            try { await Promise.all([stopped, ...handlers, ...outcomes]); }
            finally { await rm(directory, { recursive: true, force: true }); }
        }
        assert.deepEqual(handlerErrors, [], 'fake upstream must not hide handler errors');
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const config: RelayConfig = {
        host: '127.0.0.1', port: 0, relayToken: 'synthetic-keepalive-token', openAiApiKey: 'synthetic-keepalive-upstream-key',
        modelPrefix: 'relay-', defaultReasoningEffort: 'high', ngrokAuthtoken: undefined, ngrokDomain: undefined,
        logBodies: false, logDir: join(directory, 'unused-logs'), adminSnapshotDir: join(directory, 'unused-snapshots'),
        upstreamOrigin: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
        cache: { ...loadCacheConfig({}), enabled: settings.enabled, dbPath: join(directory, 'cache.sqlite'), reserveBytes: 1,
            idleTimeoutMs: 1_000, deliveryTimeoutMs: 300 },
        transport: { idleTimeoutMs: settings.idleTimeoutMs ?? 1_000, deliveryTimeoutMs: 300,
            sseKeepaliveMs: settings.sseKeepaliveMs },
    };
    relay = createRelay(config);
    relay.server.listen(0, '127.0.0.1');
    await once(relay.server, 'listening');
    const origin = `http://127.0.0.1:${(relay.server.address() as { port: number }).port}`;
    const db = (relay.runtime.store as unknown as { db: DatabaseSync } | null)?.db;
    const count = (table: 'intents' | 'intent_dependencies' | 'observations' | 'payloads') =>
        db ? Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n) : 0;
    const idle = async () => {
        await waitFor(() => relay!.runtime.inspect().activeCachedSessions === 0 && count('intents') === 0 && clients.size === 0,
            'requests must release clients, cache sessions, and intents before fixture cleanup');
        assert.equal(relay!.runtime.inspect().leasedCacheBytes, 0);
        assert.equal(count('intent_dependencies'), 0);
        assert.equal(timers.size, 0, 'upstream completion/disconnect must clear fixture timers');
    };
    const start = (messages: unknown[] = history, idleMs = 100) => {
        let body = '';
        let status: number | null = null;
        let idleExpired = false;
        let settled = false;
        const done = deferred<Outcome>();
        const settle = (complete: boolean) => {
            if (settled) return;
            settled = true;
            done.resolve({ status, body, complete, idleExpired });
        };
        const req = request(`${origin}/v1/chat/completions`, { method: 'POST', agent: false,
            headers: { authorization: 'Bearer synthetic-keepalive-token', 'content-type': 'application/json' } }, (res) => {
            status = res.statusCode ?? null;
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => { body += chunk; });
            res.once('end', () => settle(true));
            res.once('error', () => settle(false));
            res.once('close', () => { if (!res.complete) settle(false); });
        });
        if (idleMs) req.setTimeout(idleMs, () => { idleExpired = true; req.destroy(new Error('Downstream idle deadline')); });
        req.once('error', () => settle(false));
        req.once('close', () => { clients.delete(req); settle(false); });
        clients.add(req); outcomes.push(done.promise);
        req.end(JSON.stringify({ model: 'relay-keepalive-model-high', messages, stream: true, stream_options: { include_usage: true } }));
        return { done: done.promise, get body() { return body; } };
    };
    const arrived = async () => {
        await waitFor(() => received.length > 0, 'request must reach the fake upstream');
        return received[0]!;
    };
    return { start, arrived, received, idle, count, db, runtime: relay.runtime };
};

for (const enabled of [false, true]) {
    test(`keepalive: reasoning-only upstream survives downstream idle deadline with cache=${enabled}`, options, async (t) => {
        const app = await fixture(t, { enabled, sseKeepaliveMs: 20 });
        const client = app.start();
        const exchange = await app.arrived();
        const result = await beforeDeadline(client.done, '250ms reasoning phase must finish despite 100ms downstream idle timeout');
        const frames = assertCompleted(result);
        assert.ok(frames.comments.length >= 2, 'keepalive comments must reach the real downstream socket');
        assert.ok(result.body.indexOf(frames.comments[0]!) < result.body.indexOf(answer), 'comments must precede visible output');
        assert.ok(exchange.reasoningEvents >= 2, 'upstream must make progress without emitting Chat-visible text');
        assert.equal(exchange.nativeEvents, exchange.reasoningEvents + 5, 'count actual native upstream events independently');
        assert.equal(exchange.completed, true);
        await beforeDeadline(exchange.closed, 'completed upstream must close');
        await app.idle();
        t.diagnostic(`comments=${frames.comments.length}, dataFrames=${frames.data.length}, nativeEvents=${exchange.nativeEvents}`);
        assert.equal(app.count('observations'), enabled ? 1 : 0);
        assert.equal(app.count('payloads'), enabled ? 1 : 0);
        if (!enabled) { assert.equal(app.runtime.store, null); return; }
        const source = app.db!.prepare(`SELECT p.output_json, o.replayable FROM payloads p
            JOIN observations o USING(scope, end_digest)`).get()!;
        assert.equal(source.replayable, 1, 'the source cache row must remain replayable');
        assert.deepEqual(JSON.parse(String(source.output_json)), output, 'capture contains original output, never keepalive comments');
        const continuation = [...history, { role: 'assistant', content: [{ type: 'text', text: answer }] },
            { role: 'user', content: 'Synthetic followup request' }];
        assertCompleted(await beforeDeadline(app.start(continuation).done, 'followup replay must finish'));
        assert.equal(app.received.length, 2, 'neither request may be retried');
        const replayed = (app.received[1]!.body.input as JsonBody[]).filter((item) => item.type === 'reasoning' || item.type === 'message');
        assert.deepEqual(replayed, output, 'followup must replay the original encrypted reasoning and message');
        assert.equal(app.runtime.metrics.replayingDispatches, 1);
        await app.idle();
    });
}

test('keepalive: downstream comments cannot refresh a truly idle upstream watchdog with cache disabled', options, async (t) => {
    const app = await fixture(t, { enabled: false, sseKeepaliveMs: 20, idleTimeoutMs: 100, silent: true });
    const client = app.start(history, 0); // No client timeout: only the relay's upstream watchdog may close this request.
    const exchange = await app.arrived();
    const result = await beforeDeadline(client.done, '100ms upstream watchdog must terminate despite downstream heartbeats', 550);
    await beforeDeadline(exchange.closed, 'upstream watchdog must cancel the actual upstream socket', 350);
    const elapsed = exchange.closedAt! - exchange.startedAt;
    assert.ok(elapsed >= 60 && elapsed < 500, `closure must come from the 100ms idle watchdog, not fixture cleanup: ${elapsed}ms`);
    assert.equal(result.status, 200);
    assert.equal(result.complete, false);
    assert.equal(result.idleExpired, false);
    const frames = parseFrames(result.body);
    assert.ok(frames.comments.length > 0, 'heartbeat writer must be active during the genuinely idle body');
    assert.deepEqual(frames.data, [], 'idle upstream must never fabricate content or DONE');
    assert.equal(exchange.nativeEvents, 0);
    assert.equal(exchange.completed, false);
    assert.equal(app.runtime.store, null);
    await app.idle();
    t.diagnostic(`upstream cancelled after ${elapsed.toFixed(0)}ms despite ${frames.comments.length} downstream comments`);
});

test('keepalive: zero disables comments throughout a successful reasoning-only phase', options, async (t) => {
    const app = await fixture(t, { enabled: false, sseKeepaliveMs: 0 });
    const result = await beforeDeadline(app.start(history, 0).done, 'disabled keepalive stream must complete normally');
    assert.deepEqual(assertCompleted(result).comments, []);
    assert.ok(app.received[0]!.reasoningEvents >= 2);
    await app.idle();
});

test('keepalive: zero permits downstream idle disconnect and releases the upstream and cache intent', options, async (t) => {
    const app = await fixture(t, { enabled: true, sseKeepaliveMs: 0 });
    const client = app.start();
    const exchange = await app.arrived();
    assert.equal(app.count('intents'), 1, 'disconnect must exercise a real dispatched cache intent');
    const result = await beforeDeadline(client.done, '100ms downstream idle disconnect must precede the 250ms completion', 450);
    assert.equal(result.idleExpired, true);
    assert.equal(result.complete, false);
    assert.deepEqual(parseFrames(result.body).comments, []);
    assert.equal(result.body.includes('[DONE]'), false);
    await beforeDeadline(exchange.closed, 'downstream disconnect must cancel upstream transport', 350);
    assert.equal(exchange.completed, false, 'fixture completion timer must not be what ends this request');
    assert.ok(exchange.reasoningEvents > 0, 'upstream was active while downstream was idle');
    await app.idle();
    assert.equal(app.count('observations'), 0);
    assert.equal(app.count('payloads'), 0);
});
