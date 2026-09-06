// Explicit opt-in adversarial live suite; synthetic data only, <=100 attempts, no tunnel.
import assert from 'node:assert/strict';
import type { JsonBody } from '../src/http.ts';
import { openAcceptance, assertCompleted, containsBlock } from './live-acceptance-support.ts';
const suite = await openAcceptance(100);
type Result = Awaited<ReturnType<typeof suite.request>>;
const textNumber = (r: Result) => Number(String(r.observation.text).replace(/[^\d-]/g, ''));
const history = (n: number): JsonBody[] => [{ role: 'system', content: 'Synthetic test: compute carefully and return only the requested integer. Never call tools unless explicitly asked.' },
    { role: 'user', content: `Calculate (${n} * 173 + 251) * 197. Output only the integer.` }];
const ask = (tag: string, messages: JsonBody[], user: string, stream = true, extra: JsonBody = {}) =>
    suite.request(tag, { messages, user, stream, max_completion_tokens: 2048, ...extra });
let serial = 0;
const unique = (name: string) => `${name}-${serial++}`;
let seed: Result | undefined;
const baseHistory = history(131);
const finishCheck = async () => { await suite.waitForIdle(); assert.equal(suite.state().intents, 0); };

try {
    await suite.check('four conversations, five turns each, interleaved streams/JSON and two restarts', async () => {
        const histories = [131, 137, 149, 157].map(history);
        const previous: Result[][] = [[], [], [], []];
        let verified = 0;
        for (let turn = 0; turn < 5; turn++) {
            if (turn === 2 || turn === 4) await suite.restart();
            const results = await Promise.all(histories.map((messages, i) => ask(`chain-${i}-${turn}`, messages, `deep-chain-${i}`, (i + turn) % 2 === 0)));
            for (const [i, result] of results.entries()) {
                assertCompleted(result);
                const expected = ([131, 137, 149, 157][i]! * 173 + 251) * 197 + turn * 7;
                assert.equal(textNumber(result), expected);
                if (Number(result.observation.encryptedInput) > 0) {
                    assert.ok(previous[i]!.some((prior) => containsBlock(result.input, prior.output)));
                    verified++;
                }
                for (let other = 0; other < 4; other++) if (other !== i)
                    for (const prior of previous[other]!) assert.equal(containsBlock(result.input, prior.output), false);
                histories[i]!.push(result.envelope, { role: 'user', content: 'Add exactly 7 to the previous result. Output only the new integer.' });
                previous[i]!.push(result);
            }
            await finishCheck();
        }
        assert.ok(verified >= 4, 'Need actual replay evidence in multiple followups');
    });
    await suite.check('seed isolated branch for mutation and configuration matrix', async () => {
        seed = await ask('matrix-seed', baseHistory, 'matrix'); assertCompleted(seed);
        assert.ok(Number(seed.observation.encryptedOutput) > 0);
    });
    const mutations: Array<{ name: string; modify: (h: JsonBody[]) => JsonBody[]; extra?: JsonBody; user?: string; hit: boolean }> = [
        { name: 'canonical-equivalent-key-order-and-empty-calls', modify: (h) => [h[0]!, h[1]!, { tool_calls: [], content: seed!.observation.text, role: 'assistant' }, h[3]!], hit: true },
        { name: 'edited-user-message', modify: (h) => h.map((m, i) => i === 1 ? { ...m, content: `${m.content} Use formal formatting.` } : m), hit: false },
        { name: 'edited-assistant-answer', modify: (h) => h.map((m, i) => i === 2 ? { role: 'assistant', content: `${seed!.observation.text}\nVerified.` } : m), hit: false },
        { name: 'history-compaction', modify: (h) => [h[0]!, { role: 'user', content: 'Summary: previous result was 4514058. Repeat it.' }], hit: false },
        { name: 'different-caller', modify: (h) => h, user: 'matrix-other-caller', hit: false },
        { name: 'changed-tool-schema', modify: (h) => h, extra: { tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } }] }, hit: false },
        { name: 'changed-output-limit', modify: (h) => h, extra: { max_completion_tokens: 1024 }, hit: false },
        { name: 'unknown-top-level-observe-only', modify: (h) => h, extra: { synthetic_unclassified: true }, hit: false },
    ];
    for (const mutation of mutations) await suite.check(`matrix: ${mutation.name}`, async () => {
        assert.ok(seed);
        const h = mutation.modify([...baseHistory, seed.envelope, { role: 'user', content: 'Repeat the previous integer.' }]);
        const result = await ask(unique('matrix'), h, mutation.user ?? 'matrix', true, mutation.extra);
        assertCompleted(result);
        assert.equal(containsBlock(result.input, seed.output), mutation.hit);
    });
    await suite.check('three live regenerations with identical visible answers never leave false uniqueness', async () => {
        const h = history(167); const generated: Result[] = [];
        for (let i = 0; i < 3; i++) { const r = await ask(`regen-${i}`, h, 'regeneration', i % 2 === 0); assertCompleted(r); generated.push(r); }
        assert.equal(new Set(generated.map((r) => r.observation.text)).size, 1);
        const next = await ask('regen-next', [...h, generated[2]!.envelope, { role: 'user', content: 'Repeat the number.' }], 'regeneration');
        assertCompleted(next); assert.equal(next.observation.encryptedInput, 0);
    });
    await suite.check('real tool arguments with Unicode, escaping and nested arrays round-trip', async () => {
        const h: JsonBody[] = [{ role: 'system', content: 'Call echo_payload exactly once with the exact requested data. After receiving its result, reply with checksum 12345 only, no more tools.' },
            { role: 'user', content: 'Call echo_payload with label Grüße — 東京 😀, path C:\\tmp\\file.txt, and values [1,2,3].' }];
        const tools = [{ type: 'function', function: { name: 'echo_payload', strict: true, parameters: {
            type: 'object', properties: { label: { type: 'string' }, path: { type: 'string' }, values: { type: 'array', items: { type: 'integer' } } },
            required: ['label', 'path', 'values'], additionalProperties: false } } }];
        const first = await ask('unicode-tool', h, 'unicode-tool', true, { tools }); assertCompleted(first);
        assert.equal(first.calls.length, 1); const fn = first.calls[0]!.function as JsonBody;
        const args = JSON.parse(String(fn.arguments)); assert.equal(args.label, 'Grüße — 東京 😀');
        assert.equal(args.path, 'C:\\tmp\\file.txt'); assert.deepEqual(args.values, [1, 2, 3]);
        h.push(first.envelope, { role: 'tool', tool_call_id: first.calls[0]!.id, name: 'echo_payload', content: JSON.stringify({ ...args, checksum: 12345 }) });
        const next = await ask('unicode-tool-result', h, 'unicode-tool', false, { tools }); assertCompleted(next); assert.equal(textNumber(next), 12345);
    });
    await suite.check('three sequential tool rounds keep call/result mapping and hidden ancestry intact', async () => {
        const tools = [{ type: 'function', function: { name: 'lookup', strict: true, parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } } }];
        const h: JsonBody[] = [{ role: 'system', content: 'When asked to look up a key, call lookup once. When its result arrives, reply with value times 17 only. Do not look up again until a new key is requested.' }];
        const completed: Result[] = [];
        for (let round = 0; round < 3; round++) {
            h.push({ role: 'user', content: `Look up key K${round} now.` });
            const call = await ask(`tool-round-${round}`, h, 'tool-chain', true, { tools }); assertCompleted(call);
            assert.equal(call.calls.length, 1); h.push(call.envelope, { role: 'tool', tool_call_id: call.calls[0]!.id, name: 'lookup', content: JSON.stringify({ key: `K${round}`, value: 137 + round }) });
            const answer = await ask(`tool-answer-${round}`, h, 'tool-chain', false, { tools }); assertCompleted(answer);
            assert.equal(textNumber(answer), (137 + round) * 17); h.push(answer.envelope); completed.push(answer);
        }
        assert.ok(completed.some((r) => Number(r.observation.encryptedInput) > 0));
    });
    await suite.check('ten simultaneous requests under cache limit two all complete and settle', async () => {
        suite.config.cache.maxConcurrent = 2;
        try {
            const results = await Promise.all(Array.from({ length: 10 }, (_, i) => ask(`pressure10-${i}`, history(181 + i), `pressure10-${i}`, i % 2 === 0)));
            results.forEach(assertCompleted); assert.ok(results.some((r) => !r.observation.cacheControls));
            assert.ok(results.some((r) => r.observation.cacheControls));
            results.forEach((r, i) => assert.equal(textNumber(r), ((181 + i) * 173 + 251) * 197));
            await finishCheck();
        } finally { suite.config.cache.maxConcurrent = 8; }
    });
    for (const stream of [true, false]) await suite.check(`token exhaustion with partial tool args stream=${stream}`, async () => {
        const tools = [{ type: 'function', function: { name: 'emit_data', parameters: { type: 'object', properties: { data: { type: 'string' } }, required: ['data'] } } }];
        const r = await ask(`tool-length-${stream}`, [{ role: 'user', content: `Call emit_data and copy this exact data string without analyzing it: ${'ABCDEFGHIJ'.repeat(400)}` }], 'length-tool', stream,
            { tools, tool_choice: { type: 'function', function: { name: 'emit_data' } }, max_completion_tokens: 256, model: 'relay-gpt-6-astra-low' });
        assert.equal(r.observation.http, 200); assert.equal(r.observation.finish, 'length'); assert.equal(r.observation.upstreamStatus, 'incomplete');
        assert.ok(r.calls.length > 0, 'Must actually truncate a tool call, not just reasoning');
        assert.throws(() => JSON.parse(String((r.calls[0]!.function as JsonBody).arguments)), 'Must preserve the partial argument fragment');
    });
    for (let i = 0; i < 3; i++) await suite.check(`cancel-and-recover cycle ${i}`, async () => {
        const r = await suite.request(`cancel-cycle-${i}`, { model: 'relay-gpt-6-astra-low', stream: true,
            messages: [{ role: 'user', content: 'Count 1 to 500, each number on its own line.' }], max_completion_tokens: 1024 }, { cancel: i !== 1, cancelHeaders: i === 1 });
        assert.equal(r.observation.canceled, true); await finishCheck();
        assertCompleted(await ask(`recover-cycle-${i}`, history(211 + i), `recovered-${i}`));
    });
    await suite.check('tiny cache capture budget preserves full Unicode JSON and SSE answers', async () => {
        const old = suite.config.cache.maxEntryBytes; suite.config.cache.maxEntryBytes = 64;
        try { for (const stream of [true, false]) {
            const r = await ask(`tiny-${stream}`, [{ role: 'user', content: 'Repeat exactly: Grüße — 東京 😀' }], `tiny-${stream}`, stream);
            assertCompleted(r); assert.match(String(r.observation.text), /Grüße — 東京 😀/u);
        } } finally { suite.config.cache.maxEntryBytes = old; }
    });
    await suite.check('Responses-shaped body on chat path remains usable and fences old cache scope', async () => {
        const r = await suite.request('responses-shape', { model: 'relay-gpt-6-astra-high', stream: true,
            input: [{ role: 'user', content: 'Return only integer 12345.' }], max_output_tokens: 128 });
        assertCompleted(r); assert.equal(textNumber(r), 12345);
    });
    for (const item of [
        { name: 'orphan-tool-result', messages: [{ role: 'tool', tool_call_id: 'nonexistent', content: 'result' }] },
        { name: 'invalid-image-data', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,bm90YW5pbWFnZQ==' } }] }] },
    ]) await suite.check(`provider validation: ${item.name}`, async () => {
        const r = await ask(item.name, item.messages, item.name, false);
        assert.ok(Number(r.observation.http) >= 400 && Number(r.observation.http) < 500); assert.ok(r.observation.error);
    });
    await suite.check('all active work settled before final shutdown', finishCheck);
} finally { await suite.close(); if (suite.results.some((r) => r.status !== 'pass')) process.exitCode = 1; }
