import assert from 'node:assert/strict';
import test from 'node:test';
import { OutputCapture } from '../src/reasoning/capture.ts';
import { createResponsesToChatStreamConverter } from '../src/convertStream.ts';
import { toChatCompletion } from '../src/convertResponse.ts';
import type { ResponsesObject, ResponsesOutputItem, ResponsesStreamEvent } from '../src/responsesTypes.ts';
import { formatSseData } from '../src/sse.ts';

const reasoning = (): ResponsesOutputItem => ({
    type: 'reasoning', id: 'reason_1', encrypted_content: 'encrypted-secret', summary: [{ type: 'summary_text', text: 'Summary' }],
});
const message = (text = 'Hello'): ResponsesOutputItem => ({
    type: 'message', id: 'message_1', role: 'assistant', status: 'completed', phase: 'final_answer',
    content: [{ type: 'output_text', text, annotations: [] }],
});
const tool = (args = '{"city": "Berlin"}', id = 'call_1'): ResponsesOutputItem => ({
    type: 'function_call', id: `item_${id}`, call_id: id, name: 'weather', arguments: args, status: 'completed',
});
const response = (output: ResponsesOutputItem[] = [reasoning(), message()]): ResponsesObject => ({
    id: 'response_1', model: 'model-snapshot-2026-09', status: 'completed', output,
});
const stream = (final = response(), options: {
    omitText?: boolean; omitTools?: boolean; omitDone?: boolean; omitTerminal?: boolean;
    rewriteDone?: (item: ResponsesOutputItem, index: number) => ResponsesOutputItem;
    maxBytes?: number; terminalType?: string; omitClientDone?: boolean;
} = {}) => {
    const capture = new OutputCapture(options.maxBytes);
    const converter = createResponsesToChatStreamConverter();
    const emit = (event: ResponsesStreamEvent) => {
        capture.addEvent(event);
        for (const frame of converter(event)) if (!(options.omitClientDone && frame.includes('[DONE]'))) capture.addFrame(frame);
    };
    emit({ type: 'response.created', response: { ...final, status: 'in_progress', output: [] } });
    final.output?.forEach((item, output_index) => {
        if (item.type !== 'function_call' || !options.omitTools) {
            emit({ type: 'response.output_item.added', item: { ...item, status: 'in_progress' }, output_index });
        }
        if (item.type === 'message' && !options.omitText) {
            for (const part of item.content ?? []) {
                const delta = part.text ?? part.refusal ?? '';
                for (const text of [delta.slice(0, 2), delta.slice(2)]) emit({
                    type: part.type === 'refusal' ? 'response.refusal.delta' : 'response.output_text.delta', delta: text,
                });
            }
        }
        if (item.type === 'function_call' && !options.omitTools) {
            const args = item.arguments ?? '';
            for (const delta of [args.slice(0, 4), args.slice(4)]) emit({ type: 'response.function_call_arguments.delta', item_id: item.id, delta });
        }
        if (!options.omitDone) emit({ type: 'response.output_item.done', output_index, item: options.rewriteDone?.(item, output_index) ?? item });
    });
    if (!options.omitTerminal) emit({ type: options.terminalType ?? 'response.completed', response: final });
    return { capture, emit };
};
const json = (final: ResponsesObject, chat: unknown = toChatCompletion(final), maxBytes?: number) => {
    const capture = new OutputCapture(maxBytes);
    capture.addJson(chat);
    return capture.finish(final);
};

test('captures actual text, encrypted reasoning and ordered original output', () => {
    const final = response();
    const { capture } = stream(final);
    const result = capture.finish();
    assert.equal(result.complete, true);
    assert.equal(result.admissible, true);
    assert.deepEqual(result.envelope, { role: 'assistant', content: 'Hello' });
    assert.equal(JSON.stringify(result.output), JSON.stringify(final.output));
    assert.equal(result.snapshot, final.model);
    assert.equal(result.output?.[0]?.encrypted_content, 'encrypted-secret');
    assert.equal(capture.finish(), result);
});

test('tracks actual tool deltas and predicts valid JSON.parse/stringify arguments', () => {
    const result = stream(response([reasoning(), tool()])).capture.finish();
    assert.equal(result.admissible, true);
    assert.deepEqual(result.envelope, {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"Berlin"}' } }],
    });
    assert.equal(result.output?.[1]?.arguments, '{"city": "Berlin"}');
});

test('reconciles mixed output and preserves original ordering and multiple calls', () => {
    const final = response([message(), reasoning(), tool('{}'), tool('{"n":2}', 'call_2')]);
    const result = stream(final).capture.finish();
    assert.equal(result.admissible, true);
    assert.equal(JSON.stringify(result.output), JSON.stringify(final.output));
});

test('does not invent client text or tool calls from the final upstream output', () => {
    assert.equal(stream(response(), { omitText: true }).capture.finish().admissible, false);
    const dropped = stream(response([reasoning(), tool()]), { omitTools: true }).capture.finish();
    assert.equal(dropped.admissible, false);
    assert.equal(dropped.envelope, null);
});

test('rejects missing call IDs, missing item IDs, duplicate IDs and unknown output kinds', () => {
    for (const item of [
        { ...tool(), call_id: undefined }, { ...tool(), id: undefined },
        { type: 'web_search_call', id: 'search_1' },
    ]) {
        assert.equal(stream(response([reasoning(), item])).capture.finish().admissible, false);
        assert.equal(json(response([reasoning(), item])).admissible, false);
    }
    assert.equal(stream(response([reasoning(), tool(), tool()])).capture.finish().admissible, false);
});

test('observes non-reasoning output without admitting it', () => {
    const result = stream(response([message()])).capture.finish();
    assert.equal(result.complete, true);
    assert.equal(result.admissible, false);
    assert.deepEqual(result.envelope, { role: 'assistant', content: 'Hello' });
    assert.equal(result.output?.length, 1);
});

test('rejects empty reasoning and a reasoning-only completion', () => {
    for (const encrypted_content of ['', ' ', null, undefined]) {
        assert.equal(json(response([{ ...reasoning(), encrypted_content }, message()])).admissible, false);
    }
    const hidden = stream(response([reasoning()])).capture.finish();
    assert.equal(hidden.envelope, null);
    assert.equal(hidden.admissible, false);
});

test('captures refusal observations, but never admits refusals', () => {
    const final = response([reasoning(), { ...message(), content: [{ type: 'refusal', refusal: 'Cannot help' }] }]);
    const result = stream(final).capture.finish();
    assert.deepEqual(result.envelope, { role: 'assistant', content: null, refusal: 'Cannot help' });
    assert.equal(result.admissible, false);
    assert.equal(result.complete, true);
    assert.equal(json(final).admissible, false);
});

test('detects done/final payload mismatches and output order disagreements', () => {
    assert.equal(stream(response(), { rewriteDone: (item) => item.type === 'reasoning' ? { ...item, id: 'different-item' } : item }).capture.finish().admissible, false);
    const final = response();
    const { capture } = stream(final);
    assert.equal(capture.finish({ ...final, output: [...final.output!].reverse() }).admissible, false);
});

test('completed reasoning ciphertext is authoritative when item.done used different encryption', () => {
    const final = response();
    const result = stream(final, { rewriteDone: (item) => item.type === 'reasoning'
        ? { ...item, encrypted_content: 'earlier-encryption' } : item }).capture.finish();
    assert.equal(result.admissible, true);
    assert.equal(result.output?.[0]?.encrypted_content, 'encrypted-secret');
    for (const change of [{ summary: [] }, { content: [] }, { encrypted_content: '' }]) {
        const invalid = stream(response(), { rewriteDone: (item) => item.type === 'reasoning' ? { ...item, ...change } : item }).capture.finish();
        assert.equal(invalid.admissible, false);
    }
});

test('collects out-of-order done events by output_index', () => {
    const final = response();
    const { capture } = stream(final, { omitDone: true, omitTerminal: true });
    capture.addEvent({ type: 'response.output_item.done', output_index: 1, item: final.output![1] });
    capture.addEvent({ type: 'response.output_item.done', output_index: 0, item: final.output![0] });
    capture.addEvent({ type: 'response.completed', response: { ...final, output: undefined } });
    capture.addFrame(formatSseData({ model: final.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
    capture.addFrame('data: [DONE]\n\n');
    assert.equal(capture.finish().admissible, true);
});

test('rejects sparse/invalid output_index and differing repeated finalized items', () => {
    for (const output_index of [-1, 1.5, undefined, 99]) {
        const { capture } = stream();
        capture.addEvent({ type: 'response.output_item.done', output_index, item: message('Wrong') });
        assert.equal(capture.finish().admissible, false);
    }
});

test('rejects incomplete, failure, error, EOF and absent client terminator', () => {
    assert.equal(stream(response(), { omitTerminal: true }).capture.finish().complete, false);
    assert.equal(stream(response(), { omitClientDone: true }).capture.finish().complete, false);
    for (const terminalType of ['response.incomplete', 'response.failed', 'error']) {
        assert.equal(stream(response(), { terminalType }).capture.finish().admissible, false);
    }
    for (const status of ['in_progress', 'incomplete', 'failed', undefined]) {
        assert.equal(json({ ...response(), status }).admissible, false);
    }
    assert.equal(json({ ...response(), error: { message: 'failed' } }).admissible, false);
    assert.equal(json({ ...response(), incomplete_details: { reason: 'max_output_tokens' } }).admissible, false);
});

test('cross-checks the actual JSON converter object against final output', () => {
    const final = response([reasoning(), message(), tool()]);
    assert.equal(json(final).admissible, true);
    const chat = toChatCompletion(final);
    chat.choices[0]!.message.content = 'Not the emitted text';
    const mismatch = json(final, chat);
    assert.equal(mismatch.admissible, false);
    assert.equal((mismatch.envelope as { content: string }).content, 'Not the emitted text');
    assert.equal(json(final, { ...toChatCompletion(final), model: 'other-model' }).admissible, false);
});

test('invalid or numerically lossy tool arguments cannot create a replay envelope', () => {
    for (const args of ['{broken', '{"n":9007199254740993}', '{"n":1e400}', '{"n":0.10000000000000001}', '{"n":-0}']) {
        const final = response([reasoning(), tool(args)]);
        for (const result of [stream(final).capture.finish(), json(final)]) {
            assert.equal(result.admissible, false, args);
            assert.equal(result.envelope, null, args);
        }
    }
    assert.equal(json(response([reasoning(), tool('{"literal":"9007199254740993","n":0.1}')])).admissible, true);
});

test('raw tool arguments must match the converter projection, not merely parsed values', () => {
    const final = response([reasoning(), tool('{"n":1}')]);
    const chat = toChatCompletion(final);
    chat.choices[0]!.message.tool_calls![0]!.function.arguments = '{ "n": 1 }';
    assert.equal(json(final, chat).admissible, false);
});

test('unknown output fields are retained for observation but not admitted', () => {
    const final = response([{ ...reasoning(), unsupported: 'secret' } as ResponsesOutputItem, message()]);
    const result = json(final);
    assert.equal(result.admissible, false);
    assert.equal(result.output?.[0]?.unsupported, 'secret');
});

test('over-limit capture releases retained data and remains unknown', () => {
    const capture = new OutputCapture(2_000);
    capture.addEvent({ type: 'response.output_item.done', output_index: 0, item: { ...reasoning(), encrypted_content: 'x'.repeat(10_000) } });
    for (let index = 0; index < 1_000; index++) capture.addFrame('data: nonsense\n\n');
    assert.deepEqual(capture.finish(response()), { envelope: null, output: null, snapshot: '', complete: false, admissible: false });
    assert.equal(json(response(), undefined, 10).envelope, null);
    assert.equal(stream(response(), { maxBytes: 0 }).capture.finish().envelope, null);
});

test('many small fragments are charged, not only large individual payloads', () => {
    const capture = new OutputCapture(4_000);
    for (let index = 0; index < 100; index++) capture.addFrame(formatSseData({ model: 'm', choices: [{ index: 0, delta: { content: '' }, finish_reason: null }] }));
    assert.equal(capture.finish().output, null);
    assert.equal(capture.finish().envelope, null);
});

test('unknown client shapes, malformed SSE and content after DONE poison the envelope', () => {
    for (const frame of ['data: not-json\n\n', 'data: {}', formatSseData({ choices: [{ index: 1, delta: {} }] }), formatSseData({ error: { message: 'fail' } })]) {
        const { capture } = stream();
        capture.addFrame(frame);
        assert.equal(capture.finish().envelope, null);
        assert.equal(capture.finish().admissible, false);
    }
});

test('copies input before callers mutate their response', () => {
    const final = response();
    const { capture } = stream(final);
    final.output![0]!.encrypted_content = 'mutated';
    assert.equal(capture.finish().output?.[0]?.encrypted_content, 'encrypted-secret');
});

test('tool field fragments accumulate by index in the actual client frames', () => {
    const final = response([reasoning(), tool('{"n":1}')]);
    const capture = new OutputCapture();
    const frame = (delta: unknown, finish_reason: unknown = null) => capture.addFrame(formatSseData({
        model: final.model, choices: [{ index: 0, delta, finish_reason }],
    }));
    frame({ role: 'assistant' });
    frame({ tool_calls: [{ index: 0, id: 'ca', type: 'function', function: { name: 'wea', arguments: '{"n"' } }] });
    frame({ tool_calls: [{ index: 0, id: 'll_1', function: { name: 'ther', arguments: ':1}' } }] });
    capture.addEvent({ type: 'response.completed', response: final });
    frame({}, 'tool_calls');
    capture.addFrame('data: [DONE]\n\n');
    assert.equal(capture.finish().admissible, true);
});

test('completed unknown-output observation stays separate from admissibility', () => {
    const final = response([reasoning(), message(), { type: 'unknown_tool', id: 'unknown' }]);
    const result = json(final);
    assert.equal(result.complete, true);
    assert.equal(result.admissible, false);
    assert.deepEqual(result.envelope, { role: 'assistant', content: 'Hello' });
});

test('deep JSON arguments and scratch-heavy client objects fail closed before parsing', () => {
    const args = '['.repeat(65) + '0' + ']'.repeat(65);
    assert.equal(json(response([reasoning(), tool(args)])).envelope, null);
    const capture = new OutputCapture(10_000);
    capture.addFrame('data: {"extra":[' + '0,'.repeat(90) + '0]}\n\n');
    assert.deepEqual(capture.finish(), { envelope: null, output: null, snapshot: '', complete: false, admissible: false });
});

test('sparse or extension-bearing arrays do not silently change output order', () => {
    const final = response();
    final.output![3] = message('Gap');
    assert.equal(json(final).admissible, false);
});

test('missing role or function type cannot be invented from upstream output', () => {
    const final = response([reasoning(), tool()]);
    const missingRole = toChatCompletion(final);
    delete (missingRole.choices[0]!.message as { role?: string }).role;
    assert.equal(json(final, missingRole).envelope, null);
    const missingType = toChatCompletion(final);
    delete (missingType.choices[0]!.message.tool_calls![0] as { type?: string }).type;
    assert.equal(json(final, missingType).envelope, null);
    assert.equal(json(final, missingType).admissible, false);
});

test('rejects item status and unsupported content even if the converter drops it', () => {
    for (const item of [
        { ...message(), status: 'incomplete' },
        { ...message(), content: [{ type: 'audio', text: 'Hello' }] },
        { ...message(), role: 'user' },
    ]) assert.equal(json(response([reasoning(), item])).admissible, false);
});
