import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalFingerprint, CanonicalLimitError, FINGERPRINT_DOMAIN, frameLength, normalizeEnvelope } from '../src/reasoning/canonical.ts';
import { CanonicalBudget, DEFAULT_HISTORY_LIMITS } from '../src/reasoning/canonicalBudget.ts';
import { emitCanonical, measureCanonical } from '../src/reasoning/canonicalWalk.ts';
import { prepareIdentity } from '../src/reasoning/identity.ts';
import type { JsonBody } from '../src/http.ts';
import type { HistoryLimits, IdentityContext } from '../src/reasoning/types.ts';

const context: IdentityContext = {
    upstreamOrigin: 'https://synthetic.example', apiKey: 'synthetic-key', relayToken: 'synthetic-token',
    secret: 'synthetic-cache-secret-not-a-real-credential', limits: { ...DEFAULT_HISTORY_LIMITS },
};
const outbound = { model: 'synthetic-resolved-model', input: [], reasoning: { effort: 'high' }, safety_identifier: 'synthetic-user' };
const prepare = (messages: unknown[], chat: JsonBody = {}, config: JsonBody = {}, overrides: Partial<IdentityContext> = {}) =>
    prepareIdentity({ model: 'synthetic-alias', messages, ...chat }, { ...outbound, ...config }, { ...context, ...overrides });
const envelopeHash = (value: unknown) => canonicalFingerprint(normalizeEnvelope(value));
const call = (argumentsValue = '{ "a": 1 }', extra: JsonBody = {}) => ({
    id: 'synthetic-call', type: 'function', function: { name: 'synthetic_function', arguments: argumentsValue }, ...extra,
});
const assistant = (content: unknown = 'synthetic answer') => ({ role: 'assistant', content });
const end = (identity: ReturnType<typeof prepare>) => identity.prefixes.at(-1);
const jsonReference = (value: unknown): string => JSON.stringify(value, (_key, child) => {
    if (child === null || typeof child !== 'object' || Array.isArray(child)) return child;
    return Object.fromEntries(Object.keys(child).sort().map((key) => [key, child[key]]));
});
const serialized = (value: unknown): string => {
    measureCanonical(value, new CanonicalBudget());
    let text = '';
    emitCanonical(value, (chunk) => { text += chunk; });
    return text;
};
const assertLimit = (run: () => unknown, limit: keyof HistoryLimits) =>
    assert.throws(run, (error: unknown) => error instanceof CanonicalLimitError && error.limit === limit);

test('assistant empty content and tool-call forms have one canonical identity', () => {
    const variants = [assistant(''), assistant(null), assistant([]), assistant([{ type: 'text', text: '' }]), { role: 'assistant' }];
    for (const variant of variants) {
        assert.equal(envelopeHash(variant), envelopeHash({ ...variant, tool_calls: [] }));
        assert.equal(end(prepare([variant])), end(prepare([assistant('')])));
        assert.equal(prepare([variant]).eligible, true);
    }
    assert.equal(envelopeHash(assistant('ab')), envelopeHash(assistant([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])));
    assert.notEqual(envelopeHash({ role: 'user', content: 'x' }), envelopeHash({ role: 'user', content: [{ type: 'text', text: 'x' }] }));
    assert.notEqual(envelopeHash({ role: 'tool', content: '' }), envelopeHash({ role: 'tool', content: [] }));
});

test('unknown nested content is retained and makes replay ineligible, not underivable', () => {
    const plain = assistant([{ type: 'text', text: 'x' }]);
    for (const content of [[{ type: 'text', text: 'x', extra: true }], [{ type: 'refusal', refusal: 'x' }]]) {
        const identity = prepare([assistant(content)]);
        assert.equal(identity.eligible, false);
        assert.equal(identity.prefixes.length, 2);
        assert.notEqual(identity.envelopes[0], envelopeHash(plain));
        assert.deepEqual((normalizeEnvelope(assistant(content)) as JsonBody).content, content);
    }
    const extension = { ...assistant('x'), nested: { secretExtension: 1 } };
    assert.notEqual(end(prepare([extension])), end(prepare([{ ...extension, nested: { secretExtension: 2 } }])));
    assert.equal(prepare([extension]).eligible, false);
});

test('optional valid indexes disappear, malformed indexes survive, incoming arguments stay exact', () => {
    const absent = { ...assistant([]), tool_calls: [call()] };
    const indexed = { ...absent, tool_calls: [call(undefined, { index: 0 })] };
    assert.equal(end(prepare([absent])), end(prepare([indexed])));
    assert.equal(prepare([indexed]).eligible, true);
    for (const index of [1, -1, '0', null, false]) {
        const malformed = { ...absent, tool_calls: [call(undefined, { index })] };
        assert.equal(prepare([malformed]).eligible, false);
        assert.notEqual(end(prepare([malformed])), end(prepare([absent])));
        assert.equal(((normalizeEnvelope(malformed) as JsonBody).tool_calls as JsonBody[])[0]!.index, index);
    }
    const compact = { ...absent, tool_calls: [call('{"a":1}')] };
    assert.notEqual(end(prepare([compact])), end(prepare([absent])));
    assert.equal((((normalizeEnvelope(absent) as JsonBody).tool_calls as JsonBody[])[0]!.function as JsonBody).arguments, '{ "a": 1 }');
});

test('supported roles, tool names and inline images replay, unsupported shapes do not', () => {
    const supported = [
        { role: 'system', content: 'synthetic system' }, { role: 'developer', content: [{ type: 'text', text: 'synthetic rules' }] },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'auto' } }] },
        { ...assistant(null), tool_calls: [call('{}', { index: 0 })] },
        { role: 'tool', tool_call_id: 'synthetic-call', name: 'synthetic_function', content: [{ type: 'text', text: 'result' }] },
    ];
    assert.equal(prepare(supported, { stream_options: { include_usage: true }, n: 1 }).eligible, true);
    for (const message of [null, 1, [], { role: 'unknown', content: '' }, { role: 'user', content: null },
        { role: 'user', content: [{ type: 'image_url', image_url: 'https://synthetic.example/image' }] },
        { role: 'tool', tool_call_id: 'x', content: '', name: 7 }, { ...assistant('x'), tool_calls: null },
        { ...assistant('x'), tool_calls: [{ ...call(), extra: true }] },
        { ...assistant('x'), tool_calls: [{ ...call(), function: { name: 'f', arguments: '{}', extra: true } }] },
    ]) assert.equal(prepare([message]).eligible, false);
});

test('scope ignores aliases, transport and unknown dropped fields, but observations remain derivable', () => {
    const baseline = prepare([assistant('x')]);
    const transport = prepare([assistant('x')], { model: 'another-alias', stream: true, stream_options: { include_usage: false }, n: 7 }, { stream: true, input: ['different translation'] });
    assert.deepEqual(baseline.scope, transport.scope);
    assert.equal(end(baseline), end(transport));
    const unknown = prepare([assistant('x')], { unknownDroppedField: { anything: 'synthetic' } });
    assert.deepEqual(baseline.scope, unknown.scope);
    assert.equal(end(baseline), end(unknown));
    assert.equal(unknown.eligible, false);
    assert.equal(prepare([assistant('x')], {}, { unknownForwardedField: true }).eligible, false);
    assert.notEqual(baseline.scope.digest, prepare([assistant('x')], {}, { unknownForwardedField: true }).scope.digest);
});

test('scope includes effective model/configuration, semantic headers, credential, caller, secret and ceilings', () => {
    const baseline = prepare([]);
    for (const config of [{ model: 'other-model' }, { reasoning: { effort: 'low' } }, { safety_identifier: 'other-user' },
        { tools: [{ type: 'function', name: 'f', parameters: { type: 'object' } }] }, { instructions: 'new instruction' },
        { temperature: 0.5 }, { text: { format: { type: 'json_object' } } }, { max_output_tokens: 100 }]) {
        assert.notEqual(baseline.scope.digest, prepare([], {}, config).scope.digest);
    }
    for (const override of [{ apiKey: 'other-key' }, { relayToken: 'other-token' }, { secret: 'other-secret' },
        { upstreamOrigin: 'https://other.synthetic.example' }, { openaiBeta: 'synthetic=v1' },
        { endpoint: '/another/v1/responses' },
        { limits: { ...context.limits, maxBytes: context.limits.maxBytes + 1 } }]) {
        assert.notEqual(baseline.scope.digest, prepare([], {}, {}, override).scope.digest);
    }
    assert.deepEqual(baseline.scope, prepare([], {}, {}, { upstreamOrigin: 'https://SYNTHETIC.example:443/' }).scope);
    assert.equal(JSON.stringify(baseline.scope).includes('synthetic-key'), false);
    assert.equal(JSON.stringify(baseline.scope).includes('synthetic-token'), false);
    assert.notEqual(prepare([], {}, { safety_identifier: undefined }).scope.caller, prepare([], {}, { safety_identifier: '' }).scope.caller);
});

test('fixed feature controls have consistent before/after dispatch scope without losing supported include values', () => {
    const baseline = prepare([]);
    assert.deepEqual(baseline.scope, prepare([], {}, { store: false, include: ['reasoning.encrypted_content'] }).scope);
    assert.deepEqual(baseline.scope, prepare([], {}, { store: true, include: [] }).scope);
    const before = prepare([], {}, { include: ['message.output_text.logprobs'] });
    const after = prepare([], {}, { store: false, include: ['message.output_text.logprobs', 'reasoning.encrypted_content'] });
    assert.deepEqual(before.scope, after.scope);
    assert.notEqual(before.scope.digest, baseline.scope.digest);
    assert.equal(prepare([], {}, { include: 'unsupported' }).eligible, false);
});

test('sorted-key JSON.stringify ordering is pinned, including integer-like keys and __proto__', () => {
    const value = JSON.parse('{"z":1,"10":10,"2":2,"01":1,"4294967295":5,"4294967294":4,"-0":0,"a":{"9":9,"1":1,"b":2,"a":1},"__proto__":{"x":1}}');
    assert.equal(serialized(value), jsonReference(value));
    assert.ok(serialized(value).startsWith('{"2":2,"10":10,"4294967294":4,"-0":0,"01":1,"4294967295":5,'));
    assert.equal(canonicalFingerprint({ z: 1, a: 2 }), canonicalFingerprint({ a: 2, z: 1 }));
});

test('serializer matches JSON.stringify on Unicode, escapes, scalar JSON and adversarial key strings', () => {
    const strings = ['', '"\\\b\f\n\r\t', '\u0000\u0001\u001f', '\u2028\u2029', '\ud800', '\udfff', '\ud83d\ude00', '\ud800x\udc00', 'é漢字', 'x'.repeat(1023) + '\ud83d\ude00'];
    for (const value of [...strings, null, true, false, -0, 1e30, [1, null, 'x'], { '\ud800': '\udfff', 'é': '\u2028' }]) {
        assert.equal(serialized(value), jsonReference(value));
    }
    for (let unit = 0; unit <= 0xffff; unit += 251) {
        const value = String.fromCharCode(unit) + String.fromCharCode(0xd800) + String.fromCharCode(unit);
        assert.equal(serialized(value), JSON.stringify(value));
    }
    assert.equal(envelopeHash(assistant([{ type: 'text', text: '\ud83d' }, { type: 'text', text: '\ude00' }])), envelopeHash(assistant('\ud83d\ude00')));
});

test('fingerprints frame canonical UTF-8 byte length before payload bytes', () => {
    const value = { text: 'é漢字\ud83d\ude00\ud800' };
    const text = jsonReference(value);
    const expected = createHash('sha256').update(FINGERPRINT_DOMAIN).update(frameLength(Buffer.byteLength(text))).update(text).digest('hex');
    assert.equal(canonicalFingerprint(value), expected);
    assert.notEqual(Buffer.byteLength(text), text.length);
    assert.equal(frameLength(0x1_0000_0000).readBigUInt64BE(), 0x1_0000_0000n);
    assert.throws(() => frameLength(-1), RangeError);
    assert.throws(() => frameLength(Number.MAX_SAFE_INTEGER + 1), RangeError);
});

test('complete-message prefixes and copied append state predict the next canonical envelope', () => {
    const messages = [{ role: 'user', content: 'synthetic question' }];
    const identity = prepare(messages);
    const next = { ...assistant('x'), tool_calls: [call('{}')] };
    const appended = identity.append(next);
    const incoming = prepare([...messages, { ...next, content: [{ type: 'text', text: 'x' }], tool_calls: [call('{}', { index: 0 })] }]);
    assert.equal(appended.endDigest, incoming.prefixes[2]);
    assert.equal(appended.envelopeFingerprint, incoming.envelopes[1]);
    assert.deepEqual(identity.append(next), appended);
    assert.equal(identity.prefixes.length, 2);
    assert.equal(identity.messages, messages);
    assert.notEqual(end(prepare([assistant('ab')])), end(prepare([assistant('a'), assistant('b')])));
    assert.notEqual(end(prepare([{ ...assistant('x'), tool_calls: [call('{}')] }])), end(prepare([assistant('x')])));
});

test('byte, canonical node, depth, message, lookup and scratch ceilings fail closed', () => {
    const limits = (override: Partial<HistoryLimits>): HistoryLimits => ({ ...context.limits, ...override });
    const text = 'é'.repeat(100);
    const bytes = Buffer.byteLength(JSON.stringify(text));
    assert.doesNotThrow(() => canonicalFingerprint(text, limits({ maxBytes: bytes })));
    assertLimit(() => canonicalFingerprint(text, limits({ maxBytes: bytes - 1 })), 'maxBytes');
    assertLimit(() => canonicalFingerprint([1, 2], limits({ maxNodes: 2 })), 'maxNodes');
    assertLimit(() => canonicalFingerprint({ a: { b: 1 } }, limits({ maxDepth: 2 })), 'maxDepth');
    assertLimit(() => prepare([assistant('')], {}, {}, { limits: limits({ maxMessages: 0 }) }), 'maxMessages');
    assertLimit(() => prepare([assistant('')], {}, {}, { limits: limits({ maxLookups: 0 }) }), 'maxLookups');
    const wide = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`synthetic-key-${index}`, index]));
    assertLimit(() => canonicalFingerprint(wide, limits({ maxScratchBytes: 12_000 })), 'maxScratchBytes');
    assertLimit(() => prepare([], {}, { tools: [{ description: 'x'.repeat(20_000) }] }, { limits: limits({ maxBytes: 10_000 }) }), 'maxBytes');
    assertLimit(() => prepare([], {}, {}, { apiKey: 'x'.repeat(20_000), limits: limits({ maxBytes: 10_000 }) }), 'maxBytes');
});

test('resource outcomes depend on canonical quantities, not redundant assistant raw shapes', () => {
    const forms = [assistant('x'), { ...assistant([{ type: 'text', text: 'x' }]), tool_calls: [] }];
    for (const maxBytes of [1200, 1800, 10_000]) {
        const outcomes = forms.map((form) => {
            try { return end(prepare([form], {}, {}, { limits: { ...context.limits, maxBytes } })); }
            catch (error) { assert.ok(error instanceof CanonicalLimitError); return error.limit; }
        });
        assert.equal(outcomes[0], outcomes[1]);
    }
    const a = new CanonicalBudget(); const b = new CanonicalBudget();
    measureCanonical(forms[0], a, 'envelope'); measureCanonical(forms[1], b, 'envelope');
    assert.equal(a.bytes, b.bytes); assert.equal(a.nodes, b.nodes);
});

test('unclassified nested behavior and malformed configuration stay observable but cannot replay', () => {
    for (const config of [
        { reasoning: { effort: 'high', unknown: true } }, { tools: [{ type: 'function', name: 'f', extra: true }] },
        { tool_choice: { type: 'function', name: 'f', unknown: true } }, { include: ['unsupported.include'] },
        { text: { format: { type: 'json_object', unknown: true } } }, { max_output_tokens: -1 },
        { safety_identifier: 9 }, { parallel_tool_calls: 'true' },
    ]) {
        const identity = prepare([assistant('synthetic')], {}, config);
        assert.equal(identity.eligible, false);
        assert.equal(identity.prefixes.length, 2);
    }
    assert.equal(prepare([], {}, { tools: [{ type: 'function', name: 'f', parameters: { type: 'object', properties: { field: { type: 'string' } } } }] }).eligible, true);
});

test('canonical bounds are monotone across complete message prefixes and append validates the next boundary', () => {
    const identity = prepare([assistant('synthetic')], {}, {}, { limits: { ...context.limits, maxMessages: 1 } });
    assertLimit(() => identity.append(assistant('next')), 'maxMessages');
    const baseline = prepare([], {}, { include: ['message.output_text.logprobs'] });
    const repeated = prepare([], {}, { include: ['reasoning.encrypted_content', 'message.output_text.logprobs', 'message.output_text.logprobs'] });
    assert.deepEqual(baseline.scope, repeated.scope);
    const raw = [assistant('x')];
    const prepared = prepare(raw);
    const prediction = prepared.append(assistant('next'));
    raw.push(assistant('unrelated mutation'));
    assert.deepEqual(prepared.append(assistant('next')), prediction);
});

test('large strings are emitted incrementally, and normalized fingerprints use the same serializer', () => {
    const value = 'é漢字\ud83d\ude00\ud800'.repeat(4000);
    const length = measureCanonical(value, new CanonicalBudget());
    let actualBytes = 0;
    let chunks = 0;
    emitCanonical(value, (chunk) => {
        assert.ok(chunk.length <= 1030);
        actualBytes += Buffer.byteLength(chunk);
        chunks++;
    });
    assert.equal(actualBytes, length);
    assert.ok(chunks > 10);
    const message = { ...assistant([{ type: 'text', text: value }]), tool_calls: [] };
    assert.equal(prepare([message]).envelopes[0], envelopeHash(message));
});

test('3200 assistant boundaries stay inside the default independent lookup ceiling', () => {
    const messages = Array.from({ length: 3200 }, () => assistant('synthetic'));
    const identity = prepare(messages);
    assert.equal(identity.eligible, true);
    assert.equal(identity.prefixes.length, 3201);
    assert.equal(identity.envelopes.length, 3200);
});

test('total JSON values retain nested unknowns; unsupported non-JSON cycles fail without recursion overflow', () => {
    for (const value of [null, 0, 'x', false, [], { extension: [null, { x: 1 }] }]) assert.equal(prepare([value]).prefixes.length, 2);
    const cycle: JsonBody = {}; cycle.self = cycle;
    assert.throws(() => canonicalFingerprint(cycle), TypeError);
    let deep: unknown = null;
    for (let index = 0; index < 2000; index++) deep = [deep];
    assertLimit(() => canonicalFingerprint(deep), 'maxDepth');
});
