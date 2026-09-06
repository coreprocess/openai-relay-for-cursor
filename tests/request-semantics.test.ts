import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRelay } from '../src/app.ts';
import { chatToResponsesBody } from '../src/chatToResponses.ts';
import type { RelayConfig } from '../src/config.ts';
import { toChatCompletion } from '../src/convertResponse.ts';
import type { JsonBody } from '../src/http.ts';
import { OutputCapture } from '../src/reasoning/capture.ts';
import { loadCacheConfig } from '../src/reasoning/config.ts';
import { prepareIdentity } from '../src/reasoning/identity.ts';
import { ReplayRuntime } from '../src/reasoning/runtime.ts';
import { InvalidRequestError, validateGenerationBody } from '../src/requestValidation.ts';
import type { ResponsesObject } from '../src/responsesTypes.ts';
import { planUpstreamRequest } from '../src/rewrite.ts';

const effort = { aliasEffort: undefined, defaultEffort: undefined };
const base = (): JsonBody => ({ model: 'synthetic-model', messages: [{ role: 'user', content: 'Hello' }] });
const translate = (chat: JsonBody) => { validateGenerationBody(chat); return chatToResponsesBody(chat, effort); };
const call = () => ({ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } });
const definition = () => ({ type: 'function', function: { name: 'lookup', description: 'Lookup',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }, strict: true } });
const identity = (chat: JsonBody, outbound = translate(chat).body) => prepareIdentity(chat, outbound, {
    upstreamOrigin: 'https://synthetic.invalid', apiKey: 'fake', relayToken: 'synthetic', secret: 'synthetic-only',
    limits: loadCacheConfig({}).limits,
});
const fixture = (enabled: boolean) => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-request-semantics-'));
    const config: RelayConfig = {
        host: '127.0.0.1', port: 0, relayToken: 'synthetic', openAiApiKey: 'fake', modelPrefix: '',
        defaultReasoningEffort: undefined, upstreamOrigin: 'https://synthetic.invalid',
        logBodies: false, logDir: join(directory, 'unused-logs'), ngrokAuthtoken: undefined, ngrokDomain: undefined,
        cache: { ...loadCacheConfig({}), enabled, reserveBytes: 1, maxConcurrent: 1, dbPath: join(directory, 'cache.sqlite') },
    };
    return { config, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
};

const malformedRequests: JsonBody[] = [
    ...[null, false, 7, [], {}, '', ' '].map((model) => ({ ...base(), model })),
    ...[null, 'false', 0, [], {}].map((store) => ({ ...base(), store })),
    ...[null, 'reasoning.encrypted_content', {}, [false], [null], [{}]].map((include) => ({ ...base(), include })),
    ...[undefined, null, 7, {}, '', 'function', 'unknown'].map((role) => ({ ...base(), messages: [{ role, content: 'hello' }] })),
    ...['system', 'developer', 'user', 'tool'].flatMap((role) => [
        { ...base(), messages: [{ role, content: null, tool_call_id: 'call_1' }] },
        { ...base(), messages: [{ role, tool_call_id: 'call_1' }] },
    ]),
    ...[7, {}, [null], [{ text: 'missing type' }], [{ type: 'text' }], [{ type: 'text', text: {} }],
        [{ type: 'image_url', image_url: 7 }], [{ type: 'image_url', image_url: { url: [] } }],
    ].map((content) => ({ ...base(), messages: [{ role: 'user', content }] })),
    ...[null, {}, [null], [{}], [{ ...call(), function: [] }], [{ ...call(), function: 'bad' }],
        [{ ...call(), id: 7 }], [{ ...call(), function: { name: 7, arguments: '{}' } }],
        [{ ...call(), function: { name: 'lookup', arguments: {} } }],
    ].map((tool_calls) => ({ ...base(), messages: [{ role: 'assistant', content: null, tool_calls }] })),
    ...[undefined, null, 7, ''].map((tool_call_id) => ({ ...base(), messages: [{ role: 'tool', tool_call_id, content: 'ok' }] })),
    ...[null, {}, [null], [{}], [{ type: 'function' }], [{ type: 'function', function: 'bad' }],
        [{ type: 'function', function: [] }], [{ type: 'function', function: { name: 7 } }],
        [{ type: 'function', function: { name: 'lookup', parameters: [] } }],
        [{ type: 'function', function: { name: 'lookup', strict: 'true' } }],
    ].map((tools) => ({ ...base(), tools })),
    ...[null, 7, [], {}, { type: 'function', function: null }, { type: 'function', function: { name: 7 } },
        { type: 'function' }, { type: 'function', name: '' },
    ].map((tool_choice) => ({ ...base(), tool_choice })),
];

test('known malformed schemas raise InvalidRequestError before mapping', () => {
    for (const body of malformedRequests) assert.throws(() => validateGenerationBody(body), InvalidRequestError, JSON.stringify(body));
});

test('malformed schemas return HTTP 400 without upstream access', async () => {
    const fixtureData = fixture(false);
    let upstreamCalls = 0;
    const upstream = createServer((_req, res) => { upstreamCalls++; res.end('{}'); });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    fixtureData.config.upstreamOrigin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const relay = createRelay(fixtureData.config);
    relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
    const origin = `http://127.0.0.1:${(relay.server.address() as { port: number }).port}`;
    try {
        for (const body of malformedRequests) {
            const response = await fetch(`${origin}/v1/chat/completions`, {
                method: 'POST', headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            assert.equal(response.status, 400, JSON.stringify(body));
            assert.equal((await response.json() as { error: { type: string } }).error.type, 'invalid_request_error');
        }
        assert.equal(upstreamCalls, 0);
    } finally {
        await relay.close(); upstream.closeAllConnections();
        await new Promise<void>((resolve) => upstream.close(() => resolve())); fixtureData.cleanup();
    }
});

test('supported roles, content and nested function schemas stay valid and replay-eligible', () => {
    const chat = { ...base(), store: false, include: ['reasoning.encrypted_content'], tools: [definition()],
        tool_choice: { type: 'function', function: { name: 'lookup' } }, messages: [
            { role: 'system', content: 'Rules' }, { role: 'developer', content: [{ type: 'text', text: 'More rules' }] },
            { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'low' } }] },
            { role: 'assistant', content: null, tool_calls: [call()] },
            { role: 'tool', tool_call_id: 'call_1', name: 'lookup', content: [{ type: 'text', text: 'Result' }] },
            { role: 'assistant', content: 'Answer' },
        ] };
    const translated = translate(chat);
    assert.deepEqual(translated.droppedKeys, []);
    assert.deepEqual(translated.body.tools, [{ type: 'function', ...definition().function }]);
    assert.deepEqual(translated.body.tool_choice, { type: 'function', name: 'lookup' });
    assert.deepEqual((translated.body.input as JsonBody[])[3], { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' });
    assert.equal(identity(chat, translated.body).eligible, true);
    for (const content of [null, '', [], [{ type: 'text', text: '' }]]) {
        assert.deepEqual(translate({ ...base(), messages: [{ role: 'assistant', content }] }).body.input, []);
    }
    assert.deepEqual(translate({ ...base(), messages: [{ role: 'assistant' }] }).body.input, []);
    for (const tool_choice of ['auto', 'none', 'required', { type: 'function', name: 'lookup' }]) {
        assert.doesNotThrow(() => translate({ ...base(), tools: [{ type: 'function', name: 'lookup' }], tool_choice }));
    }
    assert.deepEqual(translate({ ...base(), messages: [{ role: 'assistant', tool_calls: [{ id: 'legacy', name: 'lookup' }] }] }).body.input,
        [{ type: 'function_call', call_id: 'legacy', name: 'lookup', arguments: '{}' }]);
});

test('Responses-shaped native requests preserve their existing passthrough contracts', () => {
    for (const path of ['/v1/responses', '/v1/chat/completions']) {
        const body = { model: 'synthetic-model', input: [{ role: 'user', content: 'Hello' }], store: true,
            include: ['message.output_text.logprobs'], tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }] };
        validateGenerationBody(body);
        assert.deepEqual(planUpstreamRequest(path, body, effort).body, body);
    }
    for (const invalid of [{ model: [] }, { store: 'false' }, { include: [1] }]) {
        assert.throws(() => validateGenerationBody({ model: 'synthetic', input: 'Hi', ...invalid }), InvalidRequestError);
    }
});

test('store and include are mapped without broadening unknown request forwarding', () => {
    assert.equal('store' in translate(base()).body, false);
    assert.equal('include' in translate(base()).body, false);
    for (const store of [false, true]) {
        const include = ['message.output_text.logprobs', 'reasoning.encrypted_content'];
        const translated = translate({ ...base(), store, include, provider_extension: { option: true } });
        assert.equal(translated.body.store, store);
        assert.deepEqual(translated.body.include, include);
        assert.deepEqual(translated.droppedKeys, ['provider_extension']);
        assert.equal('provider_extension' in translated.body, false);
    }
    const baseline = identity(base());
    const explicit = identity({ ...base(), store: false, include: ['reasoning.encrypted_content'] });
    assert.deepEqual(baseline.scope, explicit.scope);
    const included = identity({ ...base(), store: true, include: ['message.output_text.logprobs'] });
    assert.equal(included.eligible, true);
    assert.notEqual(included.scope.digest, baseline.scope.digest);
    assert.deepEqual(included.scope, identity({ ...base(), store: false,
        include: ['message.output_text.logprobs', 'reasoning.encrypted_content'] }).scope);
});

for (const mode of ['disabled', 'observe-only', 'bypass', 'eligible'] as const) {
    test(`explicit store/include survive ${mode} preparation`, () => {
        const fixtureData = fixture(mode !== 'disabled');
        const runtime = new ReplayRuntime(fixtureData.config);
        try {
            for (const store of [false, true]) {
                const chat = { ...base(), store, include: ['message.output_text.logprobs'],
                    ...(mode === 'observe-only' ? { provider_extension: true } : {}) };
                const outbound = translate(chat).body;
                const occupied = mode === 'bypass' ? runtime.prepare(base(), translate(base()).body, {}, true) : null;
                const result = runtime.prepare(chat, outbound, {}, true);
                const sent = result.payload ? JSON.parse(result.payload.toString()) : outbound;
                assert.equal(sent.store, mode === 'eligible' ? false : store);
                assert.deepEqual(sent.include, mode === 'eligible'
                    ? ['message.output_text.logprobs', 'reasoning.encrypted_content'] : chat.include);
                assert.equal(result.session !== null, mode === 'eligible' || mode === 'observe-only');
                result.session?.abort(); occupied?.session?.abort();
            }
        } finally { runtime.close(); fixtureData.cleanup(); }
    });
}

test('provider unknowns remain valid for observation but cannot enable replay', () => {
    for (const extension of [
        { provider_extension: { value: true } }, { include: ['provider.future_include'] },
        { tools: [{ type: 'web_search_preview', search_context_size: 'low' }] },
        { tool_choice: { type: 'provider_choice', option: true } },
        { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }] }] },
        { messages: [{ role: 'assistant', content: 'Hello', provider_extension: true }] },
    ]) {
        const chat = { ...base(), ...extension };
        const prepared = identity(chat);
        assert.equal(prepared.eligible, false, JSON.stringify(extension));
        assert.equal(prepared.prefixes.length, 2);
    }
    assert.deepEqual(translate({ ...base(), include: ['provider.future_include'] }).body.include, ['provider.future_include']);
});

const response = (): ResponsesObject => ({ id: 'response_1', model: 'synthetic-model', created_at: 123, status: 'completed', output: [
    { type: 'reasoning', id: 'reasoning_1', encrypted_content: 'opaque', summary: [] },
    { type: 'message', id: 'message_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello' }] },
], usage: { input_tokens: 4, output_tokens: 7, total_tokens: 11,
    input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 } } });

test('JSON refusal text is preserved without changing established completion fields', () => {
    const final = response();
    final.output![1]!.content = [{ type: 'output_text', text: 'Notice: ' },
        { type: 'refusal', refusal: 'Cannot ' }, { type: 'refusal', refusal: 'help.' }];
    final.output!.push({ type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'lookup', arguments: '{ "q": 1 }' });
    const chat = toChatCompletion(final);
    assert.deepEqual(chat, { id: 'response_1', object: 'chat.completion', created: 123, model: 'synthetic-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Notice: ', refusal: 'Cannot help.', tool_calls: [
            { index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{ "q": 1 }' } },
        ] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 4, completion_tokens: 7, total_tokens: 11,
            prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 3 } } });
    for (const refusal of ['Cannot help.', '']) {
        const refused = response(); refused.output![1]!.content = [{ type: 'refusal', refusal }];
        const converted = toChatCompletion(refused);
        assert.deepEqual(converted.choices[0]!.message, { role: 'assistant', content: null, refusal });
        const capture = new OutputCapture(); capture.addJson(converted);
        const result = capture.finish(refused);
        assert.equal(result.complete, true); assert.equal(result.admissible, false);
        assert.deepEqual(result.envelope, refusal ? { role: 'assistant', content: null, refusal } : null);
    }
    assert.equal('refusal' in toChatCompletion(response()).choices[0]!.message, false);
    assert.equal(toChatCompletion({ ...final, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })
        .choices[0]!.finish_reason, 'length');
});

test('unknown provider output remains observable but is never admitted', () => {
    for (const item of [{ type: 'provider_unknown', id: 'unknown' },
        { type: 'message', id: 'extra', role: 'assistant', content: [{ type: 'provider_unknown', text: 'not output_text' }] }]) {
        const final = response(); final.output!.push(item);
        const converted = toChatCompletion(final);
        assert.equal(converted.choices[0]!.message.content, 'Hello');
        const capture = new OutputCapture(); capture.addJson(converted);
        const result = capture.finish(final);
        assert.equal(result.complete, true); assert.equal(result.admissible, false);
        assert.deepEqual(result.envelope, { role: 'assistant', content: 'Hello' });
        assert.deepEqual(JSON.parse(JSON.stringify(result.output)), final.output);
    }
});
