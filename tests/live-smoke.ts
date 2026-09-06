// Manual, billable opt-in harness. Not matched by pnpm test. Never starts ngrok or loads the live relay config.
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

assert.equal(process.env.ALLOW_BILLABLE_REPLAY_SMOKE, '1', 'Explicit billable test opt-in required');
const envPath = process.env.REPLAY_SMOKE_KEY_FILE;
assert.ok(envPath, 'Explicit key source required');
const key = parseEnv(await readFile(envPath, 'utf8')).OPENAI_API_KEY;
assert.ok(typeof key === 'string' && key.startsWith('sk-'), 'OpenAI key missing; no credentials printed');
process.umask(0o077);
const directory = await mkdtemp(join(tmpdir(), 'openai-replay-live-'));
const logDir = join(directory, 'logs');
const token = randomUUID();
const config: RelayConfig = {
    host: '127.0.0.1', port: 0, relayToken: token, openAiApiKey: key, upstreamOrigin: 'https://api.openai.com',
    modelPrefix: 'relay-', defaultReasoningEffort: 'high', ngrokAuthtoken: undefined, ngrokDomain: undefined,
    logBodies: true, logDir,
    cache: { ...loadCacheConfig({}), enabled: true, dbPath: join(directory, 'cache.sqlite') },
};
let relay = createRelay(config);
let closed = false;
const listen = async () => {
    relay.server.listen(0, '127.0.0.1');
    await once(relay.server, 'listening');
    const port = (relay.server.address() as { port: number }).port;
    console.log(JSON.stringify({ event: 'test-relay-listening', port, tunnel: false, directory }));
    return `http://127.0.0.1:${port}`;
};
let origin = await listen();
const summary: JsonBody = { directory, model: 'gpt-6-astra', effort: 'high', maxCalls: 4, maxOutputTokensPerCall: 4096, cases: [] };
const cases = summary.cases as JsonBody[];
const priorOutput: JsonBody[][] = [];
const tools = [{ type: 'function', function: {
    name: 'lookup_invoice', description: 'Read the synthetic invoice. Only call if its data has not already been returned.',
    strict: true, parameters: { type: 'object', properties: { invoice_id: { type: 'string' } }, required: ['invoice_id'], additionalProperties: false },
} }];
const messages: JsonBody[] = [
    { role: 'system', content: 'You are validating a relay using synthetic data only. When asked to fetch an invoice, call lookup_invoice once and wait for its result. Never call it again after the result exists. Subsequent requests must be answered from that result. Be concise, show final calculations, not private reasoning.' },
    { role: 'user', content: 'Fetch invoice TEST-42 via lookup_invoice. Do not calculate its total until the tool result arrives.' },
];
const caller = `relay-live-test-${randomUUID()}`;
const jsonFrames = (text: string): JsonBody[] => text.split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (!data || data === '[DONE]') return [];
    try { return [JSON.parse(data) as JsonBody]; } catch { return []; }
});
const artifacts = async (before: Set<string>) => {
    for (let attempt = 0; attempt < 200; attempt++) {
        const names = await readdir(logDir).catch(() => [] as string[]);
        const added = names.filter((name) => !before.has(name));
        const request = added.find((name) => name.endsWith('2-upstream-request.json'));
        const upstream = added.find((name) => /3-upstream-(response\.(json|sse)|error\.json)$/.test(name));
        const client = added.find((name) => /4-client-response\.(json|sse)$/.test(name));
        if (request && upstream && client) return { request, upstream, client };
        await pause(50);
    }
    throw new Error('Test logs did not settle within bounded wait');
};
const call = async (label: string, stream: boolean) => {
    assert.ok(cases.length < 4, 'No automatic or extra billable calls');
    const before = new Set(await readdir(logDir).catch(() => [] as string[]));
    const started = performance.now();
    const result = await fetch(`${origin}/v1/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'relay-gpt-6-astra-high', messages, tools, tool_choice: 'auto', user: caller,
            stream, stream_options: { include_usage: true }, max_completion_tokens: 4096 }),
        signal: AbortSignal.timeout(240_000),
    });
    let content = '';
    let finishReason: unknown;
    let usage: unknown;
    let chunks = 0;
    let firstVisibleMs: number | null = null;
    let done = false;
    const calls = new Map<number, JsonBody>();
    if (!result.ok) {
        const errorText = await result.text();
        await writeFile(join(directory, 'failed-client-response.txt'), errorText, { mode: 0o600 });
        throw new Error(`Test HTTP ${result.status}; private response saved; no retry`);
    }
    if (stream) {
        for await (const event of readSseEvents(result.body!)) {
            if (event.data === '[DONE]') { done = true; continue; }
            const frame = JSON.parse(event.data);
            if (frame.error) throw new Error(`Upstream stream error ${frame.error.code ?? 'unspecified'}; no retry`);
            usage = frame.usage ?? usage;
            for (const choice of frame.choices ?? []) {
                if (choice.finish_reason) finishReason = choice.finish_reason;
                const delta = choice.delta ?? {};
                if (delta.content || delta.tool_calls?.length) {
                    firstVisibleMs ??= Math.round(performance.now() - started);
                    chunks++;
                }
                content += delta.content ?? '';
                for (const fragment of delta.tool_calls ?? []) {
                    const index = fragment.index;
                    const current = calls.get(index) ?? { index, id: '', type: 'function', function: { name: '', arguments: '' } };
                    current.id += fragment.id ?? '';
                    const fn = current.function as JsonBody;
                    fn.name += fragment.function?.name ?? '';
                    fn.arguments += fragment.function?.arguments ?? '';
                    calls.set(index, current);
                }
            }
        }
        assert.equal(done, true, 'Stream must end with DONE');
    } else {
        const json = await result.json() as { error?: unknown; usage?: unknown; choices: Array<{
            finish_reason: string; message: { content?: string; tool_calls?: JsonBody[] };
        }> };
        if (json.error) throw new Error('Upstream JSON error; no retry');
        const choice = json.choices[0];
        content = choice.message.content ?? '';
        finishReason = choice.finish_reason;
        usage = json.usage;
        for (const [index, tool] of (choice.message.tool_calls ?? []).entries()) calls.set(index, { ...tool, index });
    }
    assert.notEqual(finishReason, 'length', 'Test truncated by token cap; no automatic retry');
    const names = await artifacts(before);
    const dispatched = JSON.parse(await readFile(join(logDir, names.request), 'utf8'));
    const raw = await readFile(join(logDir, names.upstream), 'utf8');
    const response = names.upstream.endsWith('.json') ? JSON.parse(raw) :
        jsonFrames(raw).find((event) => event.type === 'response.completed')?.response as JsonBody | undefined;
    assert.ok(response, 'Final response.completed must appear in upstream logs');
    assert.equal(response.status, 'completed');
    const input = dispatched.input as JsonBody[];
    const output = (response.output ?? []) as JsonBody[];
    const replayed = input.filter((item) => item.type === 'reasoning' && typeof item.encrypted_content === 'string');
    const exactPriorBlocks = priorOutput.filter((block) => {
        const encoded = JSON.stringify(block);
        return input.some((_, index) => JSON.stringify(input.slice(index, index + block.length)) === encoded);
    }).length;
    const record: JsonBody = {
        label, stream, httpStatus: result.status, finishReason, firstVisibleMs, visibleChunks: chunks,
        elapsedMs: Math.round(performance.now() - started), outputItemTypes: output.map((item) => item.type),
        encryptedOutputItems: output.filter((item) => typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0).length,
        encryptedInputItems: replayed.length, exactPriorBlocks, store: dispatched.store, include: dispatched.include,
        responseModel: response.model, reasoningConfig: response.reasoning, usage, content,
        toolCalls: [...calls.values()].map((item) => ({ name: (item.function as JsonBody).name })),
        logFiles: names,
    };
    cases.push(record);
    priorOutput.push(output);
    console.log(JSON.stringify({ event: 'live-case', ...record }));
    const envelope: JsonBody = { role: 'assistant', content: content ? [{ type: 'text', text: content }] : [] };
    if (calls.size) envelope.tool_calls = [...calls.values()].map((item) => ({ ...item,
        function: { ...(item.function as JsonBody), arguments: JSON.stringify(JSON.parse(String((item.function as JsonBody).arguments))) },
    }));
    messages.push(envelope);
    return { record, calls: [...calls.values()] };
};

try {
    const first = await call('streaming-tool-call', true);
    assert.equal(first.calls.length, 1, 'Expected one invoice lookup');
    assert.equal((first.calls[0]!.function as JsonBody).name, 'lookup_invoice');
    messages.push({ role: 'tool', tool_call_id: first.calls[0]!.id, name: 'lookup_invoice', content: JSON.stringify({
        invoice_id: 'TEST-42', currency: 'EUR', items: [{ unit_price: 120, quantity: 3 }, { unit_price: 80, quantity: 2 }],
        discount_percent: 10, shipping: 15, vat_percent: 19,
        rule: 'Discount goods only, add shipping, then apply VAT to that sum.',
    }) });
    messages.push({ role: 'user', content: 'Calculate the gross total to two decimals. Use the returned data and do not call any tool again.' });
    const second = await call('streaming-tool-result-follow-up', true);
    assert.equal(second.calls.length, 0);
    assert.match(String(second.record.content), /574[.,]77/);
    await relay.close();
    closed = true;
    relay = createRelay(config);
    closed = false;
    origin = await listen();
    messages.push({ role: 'user', content: 'Using the same invoice, change only the goods discount to 15%. Calculate the new gross total and gross savings versus the previous answer. Do not call a tool.' });
    const third = await call('restart-then-json-follow-up', false);
    assert.equal(third.calls.length, 0);
    assert.match(String(third.record.content), /543[.,]83/);
    messages.push({ role: 'user', content: 'Return the original total, revised total, and savings in one short sentence. Do not call a tool.' });
    const fourth = await call('json-to-streaming-follow-up', true);
    assert.equal(fourth.calls.length, 0);
    assert.match(String(fourth.record.content), /30[.,]94/);
    summary.transportAndArithmeticPassed = true;
    summary.replayVerified = cases.slice(2).every((record) => Number(record.encryptedInputItems) > 0 && Number(record.exactPriorBlocks) > 0);
    assert.equal(summary.replayVerified, true, 'Restart and JSON-to-streaming follow-ups must replay original encrypted blocks');
} catch (error) {
    summary.failure = error instanceof Error ? error.message.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]') : 'Test failed';
    process.exitCode = 1;
} finally {
    if (!closed) await relay.close();
    const db = new DatabaseSync(config.cache.dbPath, { readOnly: true });
    summary.database = {
        observations: db.prepare('SELECT count(*) count FROM observations').get()?.count,
        replayable: db.prepare('SELECT count(*) count FROM observations WHERE replayable=1').get()?.count,
        payloads: db.prepare('SELECT count(*) count FROM payloads').get()?.count,
        markers: db.prepare('SELECT kind, count(*) count FROM markers GROUP BY kind').all(),
        unresolvedIntents: db.prepare('SELECT count(*) count FROM intents').get()?.count,
    };
    db.close();
    summary.testRelayStopped = true;
    await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ event: 'live-summary', ...summary }));
}
