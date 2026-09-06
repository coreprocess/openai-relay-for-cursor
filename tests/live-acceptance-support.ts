import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createRelay } from '../src/app.ts';
import { loadCacheConfig } from '../src/reasoning/config.ts';
import type { RelayConfig } from '../src/config.ts';
import type { JsonBody } from '../src/http.ts';
import { readSseEvents } from '../src/sse.ts';

export const openAcceptance = async (maxRequests = 20) => {
    assert.ok(Number.isSafeInteger(maxRequests) && maxRequests >= 1 && maxRequests <= 200);
    assert.equal(process.env.ALLOW_BILLABLE_REPLAY_SMOKE, '1', 'Explicit billable test opt-in required');
    assert.ok(process.env.REPLAY_SMOKE_KEY_FILE);
    const key = parseEnv(await readFile(process.env.REPLAY_SMOKE_KEY_FILE, 'utf8')).OPENAI_API_KEY;
    assert.ok(typeof key === 'string' && key.startsWith('sk-'), 'Key missing; never printed');
    process.umask(0o077);
    const directory = await mkdtemp(join(tmpdir(), 'openai-replay-acceptance-'));
    const config: RelayConfig = {
        host: '127.0.0.1', port: 0, relayToken: randomUUID(), openAiApiKey: key, upstreamOrigin: 'https://api.openai.com',
        modelPrefix: 'relay-', defaultReasoningEffort: 'high', ngrokAuthtoken: undefined, ngrokDomain: undefined,
        logBodies: true, logDir: join(directory, 'logs'),
        cache: { ...loadCacheConfig({}), enabled: true, dbPath: join(directory, 'cache.sqlite') },
    };
    let relay = createRelay(config);
    const ports: number[] = [];
    const listen = async () => {
        relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
        const port = (relay.server.address() as { port: number }).port;
        ports.push(port);
        return `http://127.0.0.1:${port}`;
    };
    let origin = await listen();
    let calls = 0;
    const results: JsonBody[] = [];
    const observations: JsonBody[] = [];
    const summary: JsonBody = { directory, ports, model: 'gpt-6-astra', effort: 'high', maxBillableRequests: maxRequests, results, observations };
    let saves = Promise.resolve();
    const save = () => {
        const content = JSON.stringify(summary, null, 2);
        saves = saves.then(() => writeFile(join(directory, 'summary.json'), content, { mode: 0o600 }));
        return saves;
    };
    const check = async (name: string, run: () => Promise<void> | void) => {
        if (process.env.REPLAY_ACCEPTANCE_FILTER && !name.includes(process.env.REPLAY_ACCEPTANCE_FILTER)) return;
        try { await run(); results.push({ name, status: 'pass' }); }
        catch (error) { results.push({ name, status: 'fail', error: String(error instanceof Error ? error.message : error).slice(0, 2000) }); }
        console.log(JSON.stringify(results.at(-1))); await save();
    };
    const logged = async (tag: string, step: string): Promise<string | null> => {
        for (let attempt = 0; attempt < 160; attempt++) {
            const names = await readdir(config.logDir).catch(() => [] as string[]);
            for (const header of names.filter((name) => name.endsWith('0-client-headers.json'))) {
                const headers = JSON.parse(await readFile(join(config.logDir, header), 'utf8'));
                if (headers['x-test-case'] !== tag) continue;
                const prefix = header.slice(0, -'0-client-headers.json'.length);
                const name = names.find((name) => name.startsWith(prefix) && name.includes(step));
                if (name) return await readFile(join(config.logDir, name), 'utf8');
            }
            await pause(50);
        }
        return null;
    };
    const request = async (tag: string, body: JsonBody, options: { cancel?: boolean; cancelHeaders?: boolean; path?: string } = {}) => {
        assert.ok(++calls <= maxRequests, 'Live API call cap exceeded');
        const controller = new AbortController();
        const started = performance.now();
        const response = await fetch(`${origin}${options.path ?? '/v1/chat/completions'}`, {
            method: 'POST', headers: { authorization: `Bearer ${config.relayToken}`, 'content-type': 'application/json', 'x-test-case': tag },
            body: JSON.stringify({ model: 'relay-gpt-6-astra-high',
                ...('input' in body ? { max_output_tokens: 2048 } : { max_completion_tokens: 2048 }), ...body }),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]),
        });
        let text = ''; let finish: unknown; let done = false; let chunks = 0; let usage: unknown;
        let canceled = false; let error: unknown; let firstVisibleMs: number | null = null;
        const toolCalls = new Map<number, JsonBody>();
        if (options.cancelHeaders && response.ok) {
            canceled = true; controller.abort();
            try { await response.body?.cancel(); } catch { /* owned request already aborted */ }
        } else if (body.stream === true && response.ok) {
            try {
                for await (const event of readSseEvents(response.body!)) {
                    if (event.data === '[DONE]') { done = true; continue; }
                    const frame = JSON.parse(event.data);
                    error = frame.error ?? error; usage = frame.usage ?? usage;
                    for (const choice of frame.choices ?? []) {
                        finish = choice.finish_reason ?? finish;
                        const delta = choice.delta ?? {};
                        if (delta.content || delta.tool_calls?.length) { firstVisibleMs ??= Math.round(performance.now() - started); chunks++; }
                        text += delta.content ?? '';
                        for (const fragment of delta.tool_calls ?? []) {
                            const current = toolCalls.get(fragment.index) ?? { index: fragment.index, type: 'function', id: '', function: { name: '', arguments: '' } };
                            current.id += fragment.id ?? '';
                            const fn = current.function as JsonBody;
                            fn.name += fragment.function?.name ?? ''; fn.arguments += fragment.function?.arguments ?? '';
                            toolCalls.set(fragment.index, current);
                        }
                    }
                    if (options.cancel && text.length) { canceled = true; controller.abort(); break; }
                }
            } catch (caught) { if (!canceled) throw caught; }
        } else {
            const json = await response.json() as { error?: unknown; usage?: unknown; choices?: Array<{ finish_reason: string; message: JsonBody }> };
            error = json.error; usage = json.usage;
            const choice = json.choices?.[0];
            text = String(choice?.message.content ?? ''); finish = choice?.finish_reason;
            for (const [index, call] of ((choice?.message.tool_calls ?? []) as JsonBody[]).entries()) toolCalls.set(index, { ...call, index });
        }
        const wireText = await logged(tag, '2-upstream-request.json');
        const wire = wireText ? JSON.parse(wireText) as JsonBody : null;
        const raw = await logged(tag, '3-upstream-');
        let upstream: JsonBody | null = null;
        if (raw && body.stream === true && response.ok) {
            async function* data() { yield Buffer.from(raw!); }
            for await (const event of readSseEvents(data())) {
                const frame = JSON.parse(event.data);
                if (['response.completed', 'response.incomplete', 'response.failed'].includes(frame.type)) upstream = frame.response;
            }
        } else if (raw) { upstream = JSON.parse(raw); }
        const output = (upstream?.output ?? []) as JsonBody[];
        const input = (wire?.input ?? []) as JsonBody[];
        const encryptedInput = input.filter((item) => typeof item.encrypted_content === 'string' && item.encrypted_content.length);
        const observation: JsonBody = { tag, http: response.status, finish, done, chunks, firstVisibleMs, canceled,
            elapsedMs: Math.round(performance.now() - started), encryptedInput: encryptedInput.length,
            encryptedOutput: output.filter((item) => typeof item.encrypted_content === 'string' && item.encrypted_content.length).length,
            outputTypes: output.map((item) => item.type), upstreamStatus: upstream?.status,
            toolCalls: toolCalls.size, cacheControls: wire?.store === false, usage, text, error: error ?? null };
        observations.push(observation); console.log(JSON.stringify({ event: 'case-result', ...observation })); await save();
        const envelope: JsonBody = { role: 'assistant', content: text ? [{ type: 'text', text }] : [] };
        if (toolCalls.size) envelope.tool_calls = [...toolCalls.values()].map((call) => ({ ...call,
            function: { ...(call.function as JsonBody), arguments: finish === 'tool_calls' && !canceled
                ? JSON.stringify(JSON.parse(String((call.function as JsonBody).arguments))) : String((call.function as JsonBody).arguments) } }));
        return { observation, envelope, output, wire, input, calls: [...toolCalls.values()] };
    };
    return { directory, config, check, request, results, summary,
        state: () => {
            const active = relay.runtime as unknown as { store: { db: DatabaseSync } | null; sessions: Set<unknown> };
            return { sessions: active.sessions.size,
                intents: Number(active.store?.db.prepare('SELECT count(*) count FROM intents').get()?.count ?? 0),
                payloads: Number(active.store?.db.prepare('SELECT count(*) count FROM payloads').get()?.count ?? 0),
                markers: active.store?.db.prepare('SELECT kind,count(*) count FROM markers GROUP BY kind').all() ?? [] };
        },
        waitForIdle: async () => {
            // Inspect test-owned runtime state before shutdown can mask leaked intents.
            const active = relay.runtime as unknown as { store: { db: DatabaseSync } | null; sessions: Set<unknown> };
            for (let attempt = 0; attempt < 200; attempt++) {
                const count = Number(active.store?.db.prepare('SELECT count(*) count FROM intents').get()?.count ?? 0);
                if (count === 0 && active.sessions.size === 0) return;
                await pause(25);
            }
            throw new Error('Test relay did not settle its intents and sessions before shutdown');
        },
        local: async (path: string, auth = true) => fetch(`${origin}${path}`, { headers: auth ? { authorization: `Bearer ${config.relayToken}` } : {} }),
        restart: async (enabled = true) => { await relay.close(); config.cache.enabled = enabled; relay = createRelay(config); origin = await listen(); },
        close: async () => {
            await relay.close();
            const db = new DatabaseSync(config.cache.dbPath, { readOnly: true });
            summary.database = { unresolvedIntents: db.prepare('SELECT count(*) count FROM intents').get()?.count,
                markers: db.prepare('SELECT kind,count(*) count FROM markers GROUP BY kind').all(),
                payloads: db.prepare('SELECT count(*) count FROM payloads').get()?.count };
            db.close(); summary.billableRequestsAttempted = calls; summary.testRelayStopped = true;
            summary.passed = results.every((result) => result.status === 'pass'); await save();
            console.log(JSON.stringify({ event: 'acceptance-summary', ...summary, observations: undefined }));
        },
    };
};

export const assertCompleted = (result: Awaited<ReturnType<Awaited<ReturnType<typeof openAcceptance>>['request']>>) => {
    assert.equal(result.observation.http, 200);
    assert.equal(result.observation.upstreamStatus, 'completed');
    assert.equal(result.observation.finish, result.calls.length ? 'tool_calls' : 'stop');
    assert.equal(result.observation.error, null);
};
export const containsBlock = (input: JsonBody[], output: JsonBody[]) => output.length > 0 &&
    input.some((_, index) => JSON.stringify(input.slice(index, index + output.length)) === JSON.stringify(output));
