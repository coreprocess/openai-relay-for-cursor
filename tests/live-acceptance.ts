// Manual live acceptance suite: up to 20 billable requests, never part of pnpm test.
import assert from 'node:assert/strict';
import type { JsonBody } from '../src/http.ts';
import { openAcceptance, assertCompleted, containsBlock } from './live-acceptance-support.ts';

const suite = await openAcceptance();
const messages: JsonBody[] = [
    { role: 'system', content: 'Synthetic acceptance test. Follow requests literally. Show concise final calculations, not private reasoning. Preserve Unicode when asked.' },
    { role: 'user', content: 'Invoice: 3 items at 120 EUR and 2 at 80 EUR. Discount goods 10%, then add 15 EUR shipping, then VAT 19% on that sum. What is the gross total? Finish with Prüfzeichen: Grüße — 東京 😀.' },
];
const base = { messages, user: 'acceptance-invoice', max_completion_tokens: 4096, stream: true };
let seed: Awaited<ReturnType<typeof suite.request>> | undefined;
let afterRestart: Awaited<ReturnType<typeof suite.request>> | undefined;
try {
    await suite.check('health and unauthorized requests stay local', async () => {
        assert.equal((await suite.local('/health', false)).status, 200);
        assert.equal((await suite.local('/v1/models', false)).status, 401);
    });
    await suite.check('real models endpoint passthrough', async () => {
        const response = await suite.local('/v1/models');
        assert.equal(response.status, 200);
        const body = await response.json() as { data: unknown[] };
        assert.ok(Array.isArray(body.data));
    });
    await suite.check('streaming arithmetic, usage and Unicode', async () => {
        seed = await suite.request('seed', base); assertCompleted(seed);
        assert.equal(seed.observation.done, true);
        assert.match(String(seed.observation.text), /574[.,]77/);
        assert.match(String(seed.observation.text), /Grüße — 東京 😀/u);
        assert.ok(Number(seed.observation.encryptedOutput) > 0, 'Seed must exercise encrypted reasoning');
    });
    await suite.restart();
    await suite.check('restart persistence and equivalent assistant shape replay into JSON', async () => {
        assert.ok(seed);
        const equivalent = { ...seed.envelope, content: String(seed.observation.text), tool_calls: [] };
        afterRestart = await suite.request('restart', { ...base, stream: false,
            messages: [...messages, equivalent, { role: 'user', content: 'Change only discount to 15%. Give gross total and savings.' }] });
        assertCompleted(afterRestart);
        assert.match(String(afterRestart.observation.text), /543[.,]83/);
        assert.ok(containsBlock(afterRestart.input, seed.output), 'Original seed output block must be replayed exactly');
    });
    await suite.check('meaningful history edit produces a clean miss', async () => {
        assert.ok(seed);
        const changed = [{ ...messages[0] }, { ...messages[1], content: String(messages[1]!.content) + ' Additional branch constraint: use formal tone.' }];
        const result = await suite.request('edited-history', { ...base, messages: [...changed, seed.envelope, { role: 'user', content: 'Confirm the original total briefly.' }] });
        assertCompleted(result); assert.equal(result.observation.encryptedInput, 0);
    });
    await suite.check('different reasoning effort isolates scope', async () => {
        assert.ok(seed);
        const result = await suite.request('effort-scope', { ...base, model: 'relay-gpt-6-astra-low',
            messages: [...messages, seed.envelope, { role: 'user', content: 'Confirm the total briefly.' }] });
        assertCompleted(result); assert.equal(result.observation.encryptedInput, 0);
    });
    const tools = [{ type: 'function', function: { name: 'lookup_price', strict: true,
        description: 'Look up one product price. Call separately for each requested product.',
        parameters: { type: 'object', properties: { product: { type: 'string' } }, required: ['product'], additionalProperties: false } } }];
    const toolHistory: JsonBody[] = [
        { role: 'system', content: 'You have a price lookup tool. When asked for two products call the tool twice in the same response, once per product, before calculating. After results exist do not call it again.' },
        { role: 'user', content: 'Fetch prices for product ALPHA and product BETA with two lookup_price calls now. Wait for both results.' },
    ];
    const toolBase = { model: 'relay-gpt-6-astra-high', user: 'acceptance-tools', tools, parallel_tool_calls: true,
        tool_choice: 'auto', max_completion_tokens: 4096, messages: toolHistory, stream: true };
    let toolSeed: Awaited<ReturnType<typeof suite.request>> | undefined;
    let toolAnswer: Awaited<ReturnType<typeof suite.request>> | undefined;
    await suite.check('parallel function calls preserve IDs, names, and arguments', async () => {
        toolSeed = await suite.request('parallel-tools', toolBase); assertCompleted(toolSeed);
        assert.equal(toolSeed.calls.length, 2);
        assert.equal(new Set(toolSeed.calls.map((call) => call.id)).size, 2);
        const products = toolSeed.calls.map((call) => JSON.parse(String((call.function as JsonBody).arguments)).product).sort();
        assert.deepEqual(products, ['ALPHA', 'BETA']);
        toolHistory.push(toolSeed.envelope);
        for (const call of toolSeed.calls) {
            const product = JSON.parse(String((call.function as JsonBody).arguments)).product;
            toolHistory.push({ role: 'tool', name: 'lookup_price', tool_call_id: call.id,
                content: JSON.stringify({ product, price_eur: product === 'ALPHA' ? 120 : 80 }) });
        }
        toolHistory.push({ role: 'user', content: 'Calculate 3 ALPHA and 2 BETA, 10% goods discount, 15 EUR shipping, then 19% VAT. No more tools.' });
    });
    await suite.check('parallel tool outputs continue without duplicate calls', async () => {
        assert.ok(toolSeed?.calls.length === 2);
        toolAnswer = await suite.request('tool-results', { ...toolBase, stream: false }); assertCompleted(toolAnswer);
        assert.equal(toolAnswer.calls.length, 0); assert.match(String(toolAnswer.observation.text), /574[.,]77/);
        if (Number(toolSeed.observation.encryptedOutput) > 0) assert.ok(containsBlock(toolAnswer.input, toolSeed.output));
        toolHistory.push(toolAnswer.envelope, { role: 'user', content: 'Change only shipping from 15 to 20 EUR. Give the new gross total. No tools.' });
    });
    await suite.check('reasoning from tool-result turn replays into later streaming turn', async () => {
        assert.ok(toolAnswer);
        const result = await suite.request('tool-follow-up', toolBase); assertCompleted(result);
        assert.match(String(result.observation.text), /580[.,]72/);
        assert.ok(Number(toolAnswer.observation.encryptedOutput) > 0, 'Tool answer must exercise reasoning replay');
        assert.ok(containsBlock(result.input, toolAnswer.output));
    });
    const simple = (n: number): JsonBody => ({ stream: true, messages: [{ role: 'user', content: `Return only (${n} * 17 + 23) * 19 as an integer.` }], user: `acceptance-concurrent-${n}` });
    await suite.check('two simultaneous real generations both use cache', async () => {
        const results = await Promise.all([suite.request('concurrent-A', simple(137)), suite.request('concurrent-B', simple(149))]);
        results.forEach((result) => { assertCompleted(result); assert.equal(result.observation.cacheControls, true); });
        assert.equal(String(results[0]!.observation.text).trim(), '44688'); assert.equal(String(results[1]!.observation.text).trim(), '48564');
    });
    await suite.check('cache pressure bypasses without failed model calls', async () => {
        suite.config.cache.maxConcurrent = 1;
        try {
            const results = await Promise.all([suite.request('pressure-A', simple(151)), suite.request('pressure-B', simple(163))]);
            results.forEach(assertCompleted);
            assert.equal(results.filter((result) => result.observation.cacheControls).length, 1);
        } finally { suite.config.cache.maxConcurrent = 8; }
    });
    const long = [{ role: 'user', content: 'Write a numbered list of 500 distinct simple English nouns, one noun per line. Start immediately. Do not abbreviate.' }];
    await suite.check('stream token limit reports length and terminates cleanly', async () => {
        const result = await suite.request('incomplete-stream', { messages: long, stream: true, max_completion_tokens: 16 });
        assert.equal(result.observation.http, 200); assert.equal(result.observation.upstreamStatus, 'incomplete');
        assert.equal(result.observation.finish, 'length'); assert.equal(result.observation.done, true);
    });
    await suite.check('JSON token limit reports length rather than successful stop', async () => {
        const result = await suite.request('incomplete-json', { messages: long, stream: false, max_completion_tokens: 16 });
        assert.equal(result.observation.http, 200); assert.equal(result.observation.upstreamStatus, 'incomplete');
        assert.equal(result.observation.finish, 'length');
    });
    await suite.check('client cancellation after visible streaming does not leave a live intent', async () => {
        const result = await suite.request('cancel', { model: 'relay-gpt-6-astra-low',
            messages: [{ role: 'user', content: 'Count from 1 to 300, each integer on its own line. Start immediately.' }],
            stream: true, max_completion_tokens: 2048 }, { cancel: true });
        assert.equal(result.observation.canceled, true);
        await suite.waitForIdle();
    });
    await suite.check('relay remains usable after cancellation', async () => {
        const result = await suite.request('after-cancel', simple(173)); assertCompleted(result);
        assert.equal(String(result.observation.text).trim(), String((173 * 17 + 23) * 19));
    });
    await suite.check('invalid model preserves provider HTTP error, no auto retry', async () => {
        const result = await suite.request('invalid-model', { model: 'relay-nonexistent-acceptance-model-2026-high', messages: [{ role: 'user', content: 'hi' }], stream: false });
        assert.equal(result.observation.http, 404); assert.ok(result.observation.error);
    });
    await suite.restart(false);
    await suite.check('disabled mode preserves baseline controls', async () => {
        const result = await suite.request('disabled', simple(179)); assertCompleted(result);
        assert.equal(result.observation.cacheControls, false);
    });
    await suite.restart(true);
    await suite.check('re-enable quarantines pre-gap reasoning', async () => {
        assert.ok(seed);
        const result = await suite.request('re-enabled', { ...base, messages: [...messages, seed.envelope, { role: 'user', content: 'Confirm original total.' }] });
        assertCompleted(result); assert.equal(result.observation.encryptedInput, 0);
    });
    await suite.check('unknown dropped top-level fields remain usable without cache injection', async () => {
        const result = await suite.request('unknown-field', { ...simple(181), unknown_acceptance_field: true });
        assertCompleted(result); assert.equal(result.observation.cacheControls, false);
    });
    await suite.check('capture-budget exhaustion must not corrupt a valid response', async () => {
        const previous = suite.config.cache.maxEntryBytes; suite.config.cache.maxEntryBytes = 128;
        try {
            const result = await suite.request('capture-limit', simple(191)); assertCompleted(result);
            assert.equal(result.observation.done, true);
        } finally { suite.config.cache.maxEntryBytes = previous; }
    });
    await suite.check('all intents and active sessions settle before shutdown', () => suite.waitForIdle());
} finally {
    await suite.close();
    if (suite.results.some((result) => result.status !== 'pass')) process.exitCode = 1;
}
