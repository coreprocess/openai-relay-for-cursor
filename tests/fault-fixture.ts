import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { createRelay } from '../src/app.ts';
import type { RelayConfig } from '../src/config.ts';
import type { JsonBody } from '../src/http.ts';
import { loadCacheConfig } from '../src/reasoning/config.ts';

export const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
export const created = { type: 'response.created', response: { id: 'synthetic-response', model: 'fault-model', output: [] } };
export const reasoning = { type: 'response.output_item.done', output_index: 0,
    item: { type: 'reasoning', id: 'synthetic-reasoning', summary: [], encrypted_content: 'synthetic-fault-cipher' } };
export type Exchange = { prompt: string; body: JsonBody; res: ServerResponse; closed: boolean };
export type Outcome = { status: number | null; body: string; complete: boolean; error?: string };

export const sendHealthy = ({ prompt, res }: Exchange): void => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: `synthetic-${prompt}`, model: 'fault-model', status: 'completed', output: [
        { type: 'reasoning', id: `r-${prompt}`, summary: [], encrypted_content: `synthetic-cipher-${prompt}` },
        { type: 'message', id: `m-${prompt}`, role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: `Healthy: ${prompt}`, annotations: [] }] },
    ] }));
};

/** Only loopback listeners, synthetic credentials, and fixture-owned temporary storage. */
export const faultFixture = async (t: TestContext, options: { idleTimeoutMs?: number; maxConcurrent?: number } = {}) => {
    const directory = await mkdtemp(join(tmpdir(), 'relay-transport-faults-'));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Fault fixture watchdog expired')), 6_000);
    const received: Exchange[] = [];
    const routes = new Map<string, (exchange: Exchange) => void>();
    const handlers = new Set<Promise<void>>();
    const clients = new Set<ReturnType<typeof request>>();
    const completed: Promise<Outcome>[] = [];
    const handlerErrors: unknown[] = [];
    const unhandledErrors: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandledErrors.push(error); };
    process.on('unhandledRejection', onUnhandled);
    // Monitor only: never suppress an uncaught exception from the relay.
    process.on('uncaughtExceptionMonitor', onUnhandled);
    let relay: ReturnType<typeof createRelay> | undefined;
    const upstream = createServer((req, res) => {
        const pending = (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            assert.equal(req.url, '/v1/responses');
            assert.equal(req.headers.authorization, 'Bearer synthetic-upstream-key');
            const body: JsonBody = JSON.parse(Buffer.concat(chunks).toString());
            const input = body.input as JsonBody[];
            const content = input.findLast((item) => item.role === 'user')?.content;
            const prompt = typeof content === 'string' ? content : (content as JsonBody[]).map((item) => item.text).join('');
            const exchange: Exchange = { prompt, body, res, closed: false };
            res.once('close', () => { exchange.closed = true; });
            received.push(exchange);
            (routes.get(prompt) ?? sendHealthy)(exchange);
        })().catch((error: unknown) => {
            if (!controller.signal.aborted) handlerErrors.push(error);
            res.destroy();
        });
        handlers.add(pending);
        void pending.then(() => handlers.delete(pending));
    });
    t.after(async () => {
        clearTimeout(timer);
        const watchdogExpired = controller.signal.aborted;
        controller.abort();
        for (const client of clients) client.destroy();
        try { await relay?.close(); }
        finally {
            const stopped = upstream.listening ? new Promise<void>((resolve, reject) => {
                upstream.close((error) => error ? reject(error) : resolve());
                upstream.closeAllConnections();
            }) : Promise.resolve();
            try { await Promise.all([stopped, ...completed, ...handlers]); }
            finally {
                process.off('unhandledRejection', onUnhandled);
                process.off('uncaughtExceptionMonitor', onUnhandled);
                await rm(directory, { recursive: true, force: true });
            }
        }
        assert.equal(watchdogExpired, false, 'fixture watchdog must not be what terminates a request');
        assert.deepEqual(handlerErrors, [], 'fake upstream handler errors');
        assert.deepEqual(unhandledErrors, [], 'relay must not emit unhandled asynchronous errors');
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening', { signal: controller.signal });
    const config: RelayConfig = {
        host: '127.0.0.1', port: 0, relayToken: 'synthetic-relay-token', openAiApiKey: 'synthetic-upstream-key',
        modelPrefix: 'relay-', defaultReasoningEffort: 'high', ngrokAuthtoken: undefined, ngrokDomain: undefined,
        logBodies: false, logDir: join(directory, 'unused-logs'),
        upstreamOrigin: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
        cache: { ...loadCacheConfig({}), enabled: true, dbPath: join(directory, 'cache.sqlite'), reserveBytes: 1,
            maxConcurrent: 1, idleTimeoutMs: 3_000, deliveryTimeoutMs: 500, ...options },
    };
    relay = createRelay(config);
    relay.server.listen(0, '127.0.0.1');
    await once(relay.server, 'listening', { signal: controller.signal });
    const origin = `http://127.0.0.1:${(relay.server.address() as { port: number }).port}`;
    // Read-only diagnostics on the runtime created through the public factory. No mocks,
    // method replacement, second DB connection, or cleanup action before leak assertions.
    const internals = relay.runtime as unknown as {
        sessions: ReadonlySet<unknown>; admission: { activeSessions: number; retainedBytes: number };
    };
    const db = (relay.runtime.store as unknown as { db: DatabaseSync }).db;
    const count = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
    const state = () => ({ sessions: internals.sessions.size, active: internals.admission.activeSessions,
        retainedBytes: internals.admission.retainedBytes, intents: count('intents'),
        dependencies: count('intent_dependencies'), observations: count('observations'), payloads: count('payloads') });
    const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 1_500): Promise<void> => {
        const deadline = performance.now() + timeoutMs;
        while (!predicate() && performance.now() < deadline) await delay(5, undefined, { signal: controller.signal });
        assert.ok(predicate(), `${label}; observed state=${JSON.stringify(state())}`);
    };
    const idle = async (captures = 0): Promise<void> => {
        await waitFor(() => state().sessions === 0 && state().active === 0 && state().intents === 0, 'release sessions and intents');
        assert.deepEqual(state(), { sessions: 0, active: 0, retainedBytes: 0, intents: 0,
            dependencies: 0, observations: captures, payloads: captures }, 'no orphan sessions, leases, intents, or cache admission');
    };
    const start = (prompt: string, stream = true) => {
        let text = '';
        let status: number | null = null;
        let settled = false;
        let finish!: (outcome: Outcome) => void;
        const done = new Promise<Outcome>((resolve) => { finish = resolve; });
        const settle = (complete: boolean, error?: string) => {
            if (settled) return;
            settled = true;
            finish({ status, body: text, complete, ...(error ? { error } : {}) });
        };
        const req = request(`${origin}/v1/chat/completions`, {
            method: 'POST', agent: false, signal: controller.signal,
            headers: { authorization: 'Bearer synthetic-relay-token', 'content-type': 'application/json' },
        }, (res) => {
            status = res.statusCode ?? null;
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => { text += chunk; });
            res.once('end', () => settle(true));
            res.once('error', (error: NodeJS.ErrnoException) => settle(false, error.code ?? error.message));
            res.once('close', () => { if (!res.complete) settle(false, 'response closed early'); });
        });
        clients.add(req);
        completed.push(done);
        req.once('error', (error: NodeJS.ErrnoException) => settle(false, error.code ?? error.message));
        req.once('close', () => clients.delete(req));
        req.end(JSON.stringify({ model: 'relay-fault-model-high', messages: [{ role: 'user', content: prompt }], stream }));
        return { done, disconnect: () => req.destroy(), get body() { return text; }, get status() { return status; } };
    };
    const arrived = async (prompt: string): Promise<Exchange> => {
        await waitFor(() => received.some((entry) => entry.prompt === prompt), `upstream arrival: ${prompt}`);
        return received.find((entry) => entry.prompt === prompt)!;
    };
    const healthy = async (prompt = 'unrelated-healthy'): Promise<void> => {
        const outcome = await start(prompt, false).done;
        assert.equal(outcome.status, 200, JSON.stringify(outcome));
        assert.equal(outcome.complete, true, JSON.stringify(outcome));
        assert.equal(JSON.parse(outcome.body).choices[0].message.content, `Healthy: ${prompt}`);
        const exchange = await arrived(prompt);
        assert.equal(exchange.body.store, false, 'healthy request must regain cache admission, not just passthrough');
        assert.ok((exchange.body.include as string[]).includes('reasoning.encrypted_content'));
    };
    return { config, received, unhandledErrors, start, arrived, state, waitFor, idle, healthy,
        route: (prompt: string, handler: (exchange: Exchange) => void) => routes.set(prompt, handler) };
};
