import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { selectReplayPlan } from '../src/reasoning/planner.ts';
import { RecordReader } from '../src/reasoning/store-records.ts';
import { ReplayStore } from '../src/reasoning/store.ts';
import type { PreparedIdentity, ReplayRecord, StoreOptions } from '../src/reasoning/types.ts';

const MIB = 1024 * 1024;
const CAP = 16 * MIB;
const scope = { digest: 'chain-scope', credential: 'test-key', model: 'test-model', caller: '' };
const identityFor = (count: number): PreparedIdentity => ({
    scope, eligible: true, canonicalBytes: 1000,
    messages: [{ role: 'user', content: 'start' }, ...Array.from({ length: count }, (_, index) => ({ role: 'assistant', content: String(index) }))],
    prefixes: Array.from({ length: count + 2 }, (_, index) => `prefix:${index}`),
    envelopes: Array.from({ length: count + 1 }, (_, index) => `prefix:${index + 1}`),
    append: () => { throw new Error('unused'); },
});

test('40-record replay fits 16 MiB, reads each record once, and safely falls back beyond the real cap', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-replay-chain-test-'));
    const stores: ReplayStore[] = [];
    t.after(() => { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
    let now = 1_800_000_000_000;
    const options: StoreOptions = {
        path: join(dir, 'store.sqlite'), idleDays: 30, diskBytes: 256 * MIB,
        reserveBytes: 256 * 1024, memoryBytes: 32 * MIB, maxEntryBytes: MIB,
        maxReplayBytes: 32 * MIB, maxPlanRecords: 256, wallNow: () => now,
    };
    const first = new ReplayStore(options);
    stores.push(first);
    const chain: ReplayRecord[] = [];
    for (let index = 0; index < 41; index++) {
        const id = first.begin(scope, `prefix:${index + 1}`, chain, 9e15);
        first.observe(id, {
            endDigest: `prefix:${index + 2}`, envelopeFingerprint: `prefix:${index + 2}`,
            payloadFingerprint: `payload:${index}`, snapshot: 'test-snapshot', admit: true, deliveryDeadline: 9e15,
            output: [{ type: 'reasoning', encrypted_content: 'x'.repeat(400 * 1024) }],
        });
        first.resolve(id);
        const record = first.get(scope.digest, `prefix:${index + 2}`);
        assert.ok(record);
        chain.push(record);
    }
    first.close();
    const store = new ReplayStore({ ...options, memoryBytes: 0, maxReplayBytes: CAP });
    stores.push(store);
    const within = chain.slice(0, 40);
    assert.ok(within.reduce((sum, record) => sum + record.bytes, 0) < CAP);
    assert.ok(chain.reduce((sum, record) => sum + record.bytes, 0) > CAP);
    const read = RecordReader.prototype.read;
    const loads = new Map<string, number>();
    RecordReader.prototype.read = function (...args: Parameters<typeof read>) {
        loads.set(args[1], (loads.get(args[1]) ?? 0) + 1);
        return read.apply(this, args);
    };
    const assertDistinctLoads = () => assert.ok([...loads.values()].every((count) => count === 1), JSON.stringify([...loads]));
    try {
        const plan = selectReplayPlan(store, identityFor(40), 256, CAP);
        assert.deepEqual(plan.map((record) => record.endDigest), within.map((record) => record.endDigest));
        assert.equal(loads.size, 40);
        assertDistinctLoads();
        loads.clear();
        store.resolve(store.begin(scope, 'fresh-dispatch', plan, 9e15));
        assert.equal(loads.size, 40, 'dispatch performs fresh transaction-time reads');
        assertDistinctLoads();
        loads.clear();
        const fallback = selectReplayPlan(store, identityFor(41), 256, CAP);
        assert.ok(fallback.length > 0 && fallback.length < chain.length);
        assert.ok(fallback.reduce((sum, record) => sum + record.bytes, 0) <= CAP);
        assert.deepEqual(fallback.map((record) => record.endDigest), chain.slice(0, fallback.length).map((record) => record.endDigest));
        assertDistinctLoads();
        store.resolve(store.begin(scope, 'safe-fallback', fallback, 9e15));
        const competing = [store.begin(scope, within[0]!.startDigest, [], 9e15), store.begin(scope, within[0]!.startDigest, [], 9e15)];
        assert.throws(() => store.begin(scope, 'competing-dispatch', plan, 9e15), /no longer safe/);
        store.resolve(competing[0]!);
        assert.deepEqual(selectReplayPlan(store, identityFor(40), 256, CAP), []);
        store.resolve(competing[1]!);
        store.bypass(scope, within[0]!.startDigest);
        now += 29 * 86_400_000;
        loads.clear();
        assert.deepEqual(selectReplayPlan(store, identityFor(40), 256, CAP), []);
        assert.equal(loads.size, 40);
        assertDistinctLoads();
        assert.equal(store.get(scope.digest, within[0]!.endDigest)?.touchedAt, now);
        assert.equal(store.get(scope.digest, within.at(-1)!.endDigest)?.touchedAt, now);
        assert.throws(() => store.begin(scope, 'poisoned-dispatch', plan, 9e15), /no longer safe/);
    } finally { RecordReader.prototype.read = read; }
});
