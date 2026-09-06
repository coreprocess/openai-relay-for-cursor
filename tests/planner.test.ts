import assert from 'node:assert/strict';
import test from 'node:test';
import { reconstructInput, selectReplayPlan } from '../src/reasoning/planner.ts';
import type { PreparedIdentity, ReplayRecord } from '../src/reasoning/types.ts';
import type { ReplayStore } from '../src/reasoning/store.ts';

const record = (start: string, end: string, prior: ReplayRecord[] = []): ReplayRecord => ({
    scope: 'scope', generation: 1, startDigest: start, endDigest: end, payloadFingerprint: end,
    envelopeFingerprint: end, output: [{ type: 'reasoning', encrypted_content: end }],
    priorPlan: prior.map(({ startDigest, endDigest, payloadFingerprint }) => ({ startDigest, endDigest, payloadFingerprint })),
    producingIntentId: end, snapshot: 'model', createdAt: 0, touchedAt: 0, bytes: 10,
});
const identity: PreparedIdentity = {
    scope: { digest: 'scope', credential: 'key', model: 'model', caller: '' }, eligible: true,
    messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'A' }, { role: 'assistant', content: 'B' }],
    prefixes: ['0', '1', '2', '3'], envelopes: ['1', '2', '3'], canonicalBytes: 100, append: () => { throw new Error('unused'); },
};
const fakeStore = (records: ReplayRecord[], blocked = '') => ({
    get: (_scope: string, end: string) => records.find((r) => r.endDigest === end) ?? null,
    canReplay: (r: ReplayRecord) => r.endDigest !== blocked,
    touchVerified: () => true,
    snapshotAccepted: () => true,
}) as unknown as ReplayStore;

test('newest record dictates ancestry, including empty plan after bypass', () => {
    const a = record('1', '2');
    const b = record('2', '3');
    assert.deepEqual(selectReplayPlan(fakeStore([a, b]), identity, 10, 100).map((r) => r.endDigest), ['3']);
});

test('plan-derived budget shrinks coherently; poisoned ancestors reject descendants', () => {
    const a = record('1', '2');
    const b = record('2', '3', [a]);
    assert.deepEqual(selectReplayPlan(fakeStore([a, b]), identity, 1, 100).map((r) => r.endDigest), ['2']);
    assert.deepEqual(selectReplayPlan(fakeStore([a, b], '2'), identity, 10, 100), []);
});

test('replacement happens once and call/result validation rejects orphans', () => {
    const a = record('1', '2');
    const input = reconstructInput(identity, [a])!;
    assert.equal(input.filter((item) => item.type === 'reasoning').length, 1);
    assert.equal(input.some((item) => item.content === 'A'), false);
    const orphan = { ...identity, messages: [{ role: 'tool', tool_call_id: 'missing', content: 'result' }], prefixes: ['0', '1'] };
    assert.equal(reconstructInput(orphan, []), null);
});
