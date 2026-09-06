import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import test, { type TestContext } from 'node:test';
import { createRelay } from '../src/app.ts';
import { chatToResponsesBody } from '../src/chatToResponses.ts';
import type { RelayConfig } from '../src/config.ts';
import type { JsonBody } from '../src/http.ts';
import { loadCacheConfig } from '../src/reasoning/config.ts';
import { prepareIdentity } from '../src/reasoning/identity.ts';

const TIMEOUT_MS = 20_000;
const MODEL = 'offline-concurrency-model';
const history = (prompt: string): JsonBody[] => [{ role: 'user', content: prompt }];
const answerText = (prompt: string) => `Completed: ${prompt}`;
const continuation = (prompt: string): JsonBody[] => [
    ...history(prompt), { role: 'assistant', content: answerText(prompt) },
    { role: 'user', content: `Continue ${prompt}` },
];
const requestBody = (messages: JsonBody[], stream = false, extra: JsonBody = {}): JsonBody => ({
    model: `relay-${MODEL}-high`, messages, stream, stream_options: { include_usage: true }, ...extra,
});
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
};
const textContent = (content: unknown): string => typeof content === 'string' ? content :
    (content as JsonBody[]).map((part) => String(part.text ?? '')).join('');
const lastPrompt = (messages: JsonBody[]) => textContent(messages.findLast((item) => item.role === 'user')!.content);
const reasoning = (body: JsonBody) => (body.input as JsonBody[]).filter((item) => item.type === 'reasoning');
type Received = { body: JsonBody; prompt: string; output: JsonBody[] };

const assertCompletion = (response: Response, text: string, prompt: string, stream: boolean) => {
    assert.equal(response.status, 200, text);
    assert.equal(text.includes('offline-cipher-'), false, 'encrypted reasoning must not reach the client');
    if (!stream) {
        assert.match(response.headers.get('content-type') ?? '', /application\/json/);
        const result = JSON.parse(text);
        assert.equal(result.object, 'chat.completion');
        assert.equal(result.model, MODEL);
        assert.deepEqual(result.choices, [{
            index: 0, message: { role: 'assistant', content: answerText(prompt) }, finish_reason: 'stop',
        }]);
        assert.equal(result.usage.total_tokens, 13);
        return;
    }
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const data = text.split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
        assert.ok(frame.startsWith('data: '), frame);
        return frame.slice(6);
    });
    assert.equal(data.at(-1), '[DONE]');
    assert.equal(data.filter((value) => value === '[DONE]').length, 1);
    const chunks = data.slice(0, -1).map((value) => JSON.parse(value));
    assert.ok(chunks.every((chunk) => chunk.object === 'chat.completion.chunk' && chunk.model === MODEL));
    const choices = chunks.flatMap((chunk) => chunk.choices);
    assert.equal(choices[0].delta.role, 'assistant');
    assert.equal(choices.map((choice) => choice.delta.content ?? '').join(''), answerText(prompt));
    assert.deepEqual(choices.filter((choice) => choice.finish_reason !== null).map((choice) => choice.finish_reason), ['stop']);
    assert.equal(chunks.at(-1).usage.total_tokens, 13);
};

/** All listeners, cancellation, gates, sockets and files belong to this test fixture only. */
const setup = async (t: TestContext, maxConcurrent?: number) => {
    const directory = await mkdtemp(join(tmpdir(), 'relay-concurrency-offline-'));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Offline concurrency test timed out')), TIMEOUT_MS);
    const requests: Promise<unknown>[] = [];
    const handlers = new Set<Promise<void>>();
    const failures: unknown[] = [];
    const received: Received[] = [];
    const gates: ReturnType<typeof deferred>[] = [];
    const arrivals = new EventEmitter();
    let gate: ReturnType<typeof deferred> | undefined;
    let active = 0;
    let peak = 0;
    let relay: ReturnType<typeof createRelay> | undefined;
    const upstream = createServer((req, res) => {
        const pending = (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            assert.equal(req.url, '/v1/responses');
            assert.equal(req.headers.authorization, 'Bearer offline-fake-upstream-key');
            const body: JsonBody = JSON.parse(Buffer.concat(chunks).toString());
            const prompt = lastPrompt(body.input as JsonBody[]);
            // Different prompts AND repeated generations get different IDs, avoiding scope-wide false matches.
            const id = `${received.length}-${createHash('sha256').update(prompt).digest('hex').slice(0, 12)}`;
            const output: JsonBody[] = [
                { type: 'reasoning', id: `r-${id}`, summary: [], encrypted_content: `offline-cipher-${id}` },
                { type: 'message', id: `m-${id}`, role: 'assistant', status: 'completed',
                    content: [{ type: 'output_text', text: answerText(prompt), annotations: [] }] },
            ];
            const held = gate;
            received.push({ body, prompt, output });
            active++;
            peak = Math.max(peak, active);
            arrivals.emit('request');
            try {
                if (held) await held.promise;
                if (controller.signal.aborted || res.destroyed) return;
                const response = { id: `resp-${id}`, model: MODEL, status: 'completed', output,
                    usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } };
                if (!body.stream) {
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify(response));
                    return;
                }
                res.setHeader('content-type', 'text/event-stream');
                const emit = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\r\n\r\n`);
                emit({ type: 'response.created', response: { ...response, output: [] } });
                emit({ type: 'response.output_text.delta', delta: answerText(prompt) });
                output.forEach((item, output_index) => emit({ type: 'response.output_item.done', item, output_index }));
                emit({ type: 'response.completed', response });
                res.end();
            } finally { active--; }
        })().catch((error: unknown) => {
            if (!controller.signal.aborted) failures.push(error);
            res.destroy();
        });
        handlers.add(pending);
        void pending.finally(() => handlers.delete(pending));
    });
    t.after(async () => {
        clearTimeout(timer);
        controller.abort();
        gates.forEach((held) => held.resolve());
        try {
            await relay?.close();
        } finally {
            const stopped = upstream.listening ? new Promise<void>((resolve, reject) => {
                upstream.close((error) => error ? reject(error) : resolve());
                upstream.closeAllConnections();
            }) : Promise.resolve();
            try { await Promise.all([stopped, Promise.allSettled(requests), Promise.allSettled([...handlers])]); }
            finally { await rm(directory, { recursive: true, force: true }); }
        }
        assert.deepEqual(failures, [], 'fake upstream handlers must not fail');
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening', { signal: controller.signal });
    const config: RelayConfig = {
        host: '127.0.0.1', port: 0, relayToken: 'offline-relay-token', openAiApiKey: 'offline-fake-upstream-key',
        modelPrefix: 'relay-', defaultReasoningEffort: 'high', ngrokAuthtoken: undefined, ngrokDomain: undefined,
        logBodies: false, logDir: join(directory, 'logs'),
        upstreamOrigin: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
        cache: { ...loadCacheConfig({}), enabled: true, dbPath: join(directory, 'cache.sqlite'), reserveBytes: 1,
            ...(maxConcurrent === undefined ? {} : { maxConcurrent }) },
    };
    relay = createRelay(config);
    relay.server.listen(0, '127.0.0.1');
    await once(relay.server, 'listening', { signal: controller.signal });
    const origin = `http://127.0.0.1:${(relay.server.address() as { port: number }).port}`;
    const store = relay.runtime.store!;
    return {
        received, config, store, get active() { return active; }, get peak() { return peak; },
        hold: () => {
            assert.equal(gate, undefined, 'release the preceding barrier first');
            const held = deferred();
            gates.push(held);
            gate = held;
            const start = received.length;
            return {
                waitFor: async (count: number) => {
                    while (received.length - start < count) {
                        await once(arrivals, 'request', { signal: controller.signal });
                    }
                },
                release: () => { if (gate === held) gate = undefined; held.resolve(); },
            };
        },
        request: (messages: JsonBody[], stream = false, extra: JsonBody = {}) => {
            const pending = (async () => {
                const body = JSON.stringify(requestBody(messages, stream, extra));
                const response = await fetch(`${origin}/v1/chat/completions`, {
                    method: 'POST', headers: { authorization: 'Bearer offline-relay-token', 'content-type': 'application/json' },
                    body, signal: controller.signal,
                });
                const text = await response.text();
                assertCompletion(response, text, lastPrompt(messages), stream);
                return { bytes: Buffer.byteLength(body) };
            })();
            requests.push(pending);
            // A barrier may still be awaiting other arrivals when a request fails or times out.
            void pending.catch(() => {});
            return pending;
        },
        cached: (prompt: string) => {
            const original = { ...requestBody(history(prompt)), model: MODEL };
            const outbound = chatToResponsesBody(original, { aliasEffort: 'high', defaultEffort: 'high' }).body;
            const identity = prepareIdentity(original, outbound, {
                upstreamOrigin: config.upstreamOrigin, apiKey: config.openAiApiKey, relayToken: config.relayToken,
                secret: store.secret, limits: config.cache.limits,
            });
            const { endDigest } = identity.append({ role: 'assistant', content: answerText(prompt) });
            return store.get(identity.scope.digest, endDigest);
        },
    };
};

const assertReplay = (received: Received, original: Received, replayed: boolean) => {
    assert.equal(received.body.store, false, 'idle followup must regain full cache admission');
    assert.deepEqual(reasoning(received.body), replayed ? [original.output[0]] : []);
    const messages = (received.body.input as JsonBody[]).filter((item) => item.type === 'message');
    assert.deepEqual(messages, replayed ? [original.output[1]] : []);
};

test('default admission overlaps ten generations and captures replayable JSON and SSE replies', { timeout: 30_000 }, async (t) => {
    const app = await setup(t);
    assert.equal(app.config.cache.maxConcurrent, 10);
    const held = app.hold();
    const pending = Array.from({ length: 10 }, (_, index) => app.request(history(`default-${index}`), index % 2 === 0));
    await held.waitFor(10);
    assert.equal(app.active, 10, 'all ten must reach upstream before any response is released');
    assert.equal(app.peak, 10);
    const initial = [...app.received];
    for (const { body } of initial) {
        assert.equal(body.store, false);
        assert.deepEqual(body.include, ['reasoning.encrypted_content']);
    }
    held.release();
    await Promise.all(pending);
    for (const original of initial) {
        const record = app.cached(original.prompt);
        assert.ok(record, `missing capture for ${original.prompt}`);
        assert.ok(app.store.canReplay(record));
        assert.deepEqual(record.output, original.output);
        await app.request(continuation(original.prompt), original.body.stream !== true);
        assertReplay(app.received.at(-1)!, original, true);
    }
    assert.equal(app.received.length, 20);
});

test('capacity two forwards all eight without cache injection on excess and preserves unrelated replay', { timeout: 30_000 }, async (t) => {
    const app = await setup(t, 2);
    const held = app.hold();
    const pending = Array.from({ length: 8 }, (_, index) => app.request(history(`pressure-${index}`), index % 2 === 0));
    await held.waitFor(8);
    assert.equal(app.active, 8, 'cache capacity must not serialize or reject ordinary forwarding');
    assert.equal(app.peak, 8);
    const initial = [...app.received];
    const admitted = initial.filter(({ body }) => body.store === false);
    assert.equal(admitted.length, 2);
    for (const { body } of initial.filter((entry) => !admitted.includes(entry))) {
        assert.equal(Object.hasOwn(body, 'store'), false);
        assert.equal(Object.hasOwn(body, 'include'), false);
        assert.deepEqual(reasoning(body), []);
    }
    held.release();
    await Promise.all(pending);
    assert.equal(initial.filter(({ prompt }) => app.cached(prompt) !== null).length, 2);
    for (const original of initial) {
        const replayed = admitted.includes(original);
        assert.equal(app.cached(original.prompt) !== null, replayed);
        await app.request(continuation(original.prompt), original.body.stream !== true);
        assertReplay(app.received.at(-1)!, original, replayed);
    }
    assert.equal(app.received.length, 16);
});

test('capacity bypass poisons an earlier text-identical cached position before the uncaptured response', { timeout: 30_000 }, async (t) => {
    const app = await setup(t, 2);
    const prompt = 'same-visible-prefix';
    await app.request(history(prompt));
    const old = app.cached(prompt);
    assert.ok(old);
    assert.ok(app.store.canReplay(old));
    const held = app.hold();
    const blockers = [app.request(history('blocker-one')), app.request(history('blocker-two'), true)];
    await held.waitFor(2);
    assert.ok(app.store.canReplay(old), 'unrelated held requests must not invalidate the old position');
    const bypassed = app.request(history(prompt), true);
    await held.waitFor(3);
    const repeated = app.received.at(-1)!;
    assert.equal(Object.hasOwn(repeated.body, 'store'), false);
    assert.equal(Object.hasOwn(repeated.body, 'include'), false);
    assert.equal(app.store.canReplay(old), false, 'start poison must be durable before the bypass reaches upstream');
    held.release();
    await Promise.all([...blockers, bypassed]);
    await app.request(continuation(prompt));
    assertReplay(app.received.at(-1)!, app.received[0]!, false);
    for (const original of app.received.slice(1, 3)) {
        await app.request(continuation(original.prompt), true);
        assertReplay(app.received.at(-1)!, original, true);
    }
});

test('one real-shaped 5–6 MiB tool history completes offline with a finite event-loop delay', { timeout: 30_000 }, async (t) => {
    const app = await setup(t);
    const source = 'export function summarizeClaim(claim: Claim): string {\n    return `${claim.reference}: ${claim.status}`;\n}\n';
    const excerpt = source.repeat(Math.ceil(64 * 1024 / source.length)).slice(0, 64 * 1024);
    const messages: JsonBody[] = [{ role: 'system', content: 'Review the synthetic repository and summarize the changes.' }];
    for (let index = 0; index < 88; index++) {
        const path = `src/claims/part-${index}.ts`;
        messages.push(
            { role: 'user', content: `Inspect ${path}.` },
            { role: 'assistant', content: '', tool_calls: [{ id: `read-${index}`, type: 'function',
                function: { name: 'read_file', arguments: JSON.stringify({ path }) } }] },
            { role: 'tool', tool_call_id: `read-${index}`, name: 'read_file', content: `FILE ${path}\n${excerpt}` },
            { role: 'assistant', content: `Reviewed ${path}; its exported summary keeps the claim reference and status.` },
        );
    }
    messages.push({ role: 'user', content: 'Summarize the complete offline review.' });
    const delay = monitorEventLoopDelay({ resolution: 10 });
    t.after(() => delay.disable());
    delay.enable();
    const started = performance.now();
    const result = await app.request(messages, false, {
        tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a local source file',
            parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } }],
    });
    const elapsed = performance.now() - started;
    delay.disable();
    assert.ok(result.bytes >= 5 * 1024 * 1024 && result.bytes <= 6 * 1024 * 1024, `request bytes: ${result.bytes}`);
    assert.equal(app.received.length, 1);
    assert.equal(app.received[0]!.body.store, false, 'a single realistic large history should fit the default admission budget');
    const input = app.received[0]!.body.input as JsonBody[];
    assert.equal(input.filter((item) => item.type === 'function_call').length, 88);
    assert.equal(input.filter((item) => item.type === 'function_call_output').length, 88);
    assert.ok(delay.count > 0, 'the event-loop monitor must collect actual samples');
    assert.ok(Number.isFinite(delay.mean) && Number.isFinite(delay.max) && Number.isFinite(elapsed));
    assert.ok(elapsed < TIMEOUT_MS, 'large-context forwarding must finish within the fixture cancellation deadline');
    t.diagnostic(`offline request ${(result.bytes / 1024 / 1024).toFixed(2)} MiB; elapsed ${elapsed.toFixed(0)} ms; maximum event-loop delay ${(delay.max / 1e6).toFixed(0)} ms`);
});
