import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { DAY_MS, RetentionClock } from '../src/reasoning/retention.ts';
import { StoreFiles } from '../src/reasoning/store-files.ts';
import { RecordReader } from '../src/reasoning/store-records.ts';
import { ReplayStore, markCoverageGapIfExists } from '../src/reasoning/store.ts';
import type { ReplayPlanningStore } from '../src/reasoning/store.ts';
import type { Observation, ReplayRecord, ScopeIdentity, StoreOptions } from '../src/reasoning/types.ts';

const scope: ScopeIdentity = { digest: 'scope', credential: 'credential', model: 'alias', caller: 'caller' };
const output = (text = 'answer') => [{ type: 'reasoning', encrypted_content: text }, { type: 'message', content: [{ text }] }];

function fixture(t: TestContext, overrides: Partial<StoreOptions> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'relay-replay-store-test-'));
    let wall = 1_800_000_000_000;
    let monotonic = 0;
    const options: StoreOptions = {
        path: join(dir, 'store.sqlite'), idleDays: 30, diskBytes: 16 * 1024 * 1024,
        reserveBytes: 256 * 1024, memoryBytes: 1024 * 1024, maxEntryBytes: 128 * 1024,
        wallNow: () => wall, monotonicNow: () => monotonic, ...overrides,
    };
    const stores: ReplayStore[] = [];
    t.after(() => { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
    return {
        dir, options, now: () => wall,
        advance: (days: number) => { wall += days * DAY_MS; monotonic += days * DAY_MS; },
        jumpWall: (days: number) => { wall += days * DAY_MS; },
        open: () => { const store = new ReplayStore(options); stores.push(store); return store; },
    };
}

function observation(end = 'end', changes: Partial<Observation> = {}): Observation {
    return {
        endDigest: end, envelopeFingerprint: `envelope:${end}`, output: output(), payloadFingerprint: 'fingerprint',
        snapshot: 'model-2026-09-01', admit: true, deliveryDeadline: 9e15, ...changes,
    };
}

function publish(store: ReplayStore, start = 'start', end = 'end', plan: ReplayRecord[] = [], changes: Partial<Observation> = {}, identity = scope) {
    const id = store.begin(identity, start, plan, 9e15);
    store.observe(id, observation(end, changes));
    const record = store.get(identity.digest, end);
    return { id, record };
}

function completed(store: ReplayStore, start = 'start', end = 'end', plan: ReplayRecord[] = [], changes: Partial<Observation> = {}, identity = scope) {
    const { id, record } = publish(store, start, end, plan, changes, identity);
    store.resolve(id);
    assert.ok(record);
    return record;
}

function inspect(path: string, query: string) {
    const db = new DatabaseSync(path, { readOnly: true });
    try { return db.prepare(query).all(); } finally { db.close(); }
}

test('persists exact JSON, fingerprints, prior plan, secret, and owner-only files', (t) => {
    const f = fixture(t);
    const first = f.open();
    const a = completed(first);
    const b = completed(first, 'next-start', 'next-end', [a], { output: output('second'), payloadFingerprint: 'second-fingerprint' });
    assert.equal(first.canReplay(b), true);
    assert.deepEqual(b.priorPlan, [{ startDigest: a.startDigest, endDigest: a.endDigest, payloadFingerprint: a.payloadFingerprint }]);
    const secret = first.secret;
    assert.equal(statSync(`${f.options.path}.secret`).mode & 0o777, 0o600);
    assert.equal(statSync(f.options.path).mode & 0o777, 0o600);
    first.close();
    const second = f.open();
    assert.equal(second.secret, secret);
    assert.deepEqual(second.get(scope.digest, 'next-end')?.output, output('second'));
    assert.equal(second.canReplay(second.get(scope.digest, 'next-end')!), true);
});

test('exclusive connection acquires write lock at startup', (t) => {
    const f = fixture(t);
    f.open();
    assert.throws(() => new ReplayStore(f.options), /locked/);
});

test('existing database without secret fails and unsafe secret permissions fail', (t) => {
    const f = fixture(t);
    f.open().close();
    chmodSync(`${f.options.path}.secret`, 0o644);
    assert.throws(() => f.open(), /owner-only/);
    unlinkSync(`${f.options.path}.secret`);
    assert.throws(() => f.open(), /missing its secret/);
});

test('upstream validation rejection invalidates only the dispatched replay blocks', (t) => {
    const store = fixture(t).open();
    const a = completed(store, 'a-start', 'a-end');
    const b = completed(store, 'b-start', 'b-end');
    const id = store.begin(scope, 'continuation', [a], 9e15);
    store.rejectReplay(id);
    assert.equal(store.canReplay(a), false);
    assert.equal(store.canReplay(b), true);
    store.poison(id);
});

test('capacity bypass poisons old and future payloads at that position but not unrelated histories', (t) => {
    const f = fixture(t);
    const store = f.open();
    const previous = completed(store, 'crowded-start', 'old-answer');
    const unrelated = completed(store, 'other-start', 'other-answer');
    const pending = store.begin(scope, 'crowded-start', [], 9e15);
    store.bypass(scope, 'crowded-start');
    assert.equal(store.canReplay(previous), false);
    assert.equal(store.canReplay(unrelated), true);
    store.observe(pending, observation('new-answer'));
    store.resolve(pending);
    assert.equal(store.get(scope.digest, 'new-answer'), null);
    store.close();
    const restarted = f.open();
    assert.equal(restarted.canReplay(restarted.get(scope.digest, 'old-answer')!), false);
    assert.equal(restarted.canReplay(restarted.get(scope.digest, 'other-answer')!), true);
});

test('producer exemption never exempts any competing unresolved intent', (t) => {
    const store = fixture(t).open();
    const { id: producer, record } = publish(store);
    assert.ok(record);
    assert.equal(store.canReplay(record), true);
    const competitors = [store.begin(scope, 'start', [], 9e15), store.begin(scope, 'start', [], 9e15)];
    assert.equal(store.canReplay(record), false);
    store.resolve(competitors[0]!);
    assert.equal(store.canReplay(record), false);
    store.resolve(producer);
    assert.equal(store.canReplay(record), false);
    store.resolve(competitors[1]!);
    assert.equal(store.canReplay(record), true);
});

test('observation exact payload and provenance divergence permanently conflict', (t) => {
    const store = fixture(t).open();
    const record = completed(store);
    const id = store.begin(scope, 'start', [], 9e15);
    store.observe(id, observation('end', { output: output('different'), payloadFingerprint: 'fingerprint' }));
    store.resolve(id);
    assert.equal(store.canReplay(record), false);
    store.fence(scope.credential, scope.model);
    const retry = store.begin(scope, 'start', [], 9e15);
    store.observe(retry, observation());
    store.resolve(retry);
    assert.equal(store.canReplay(store.get(scope.digest, 'end')!), false);
    const ancestor = completed(store, 'ancestor-start', 'ancestor-end');
    const child = completed(store, 'child-start', 'child-end', [ancestor]);
    const divergent = store.begin(scope, 'child-start', [], 9e15);
    store.observe(divergent, observation('child-end'));
    store.resolve(divergent);
    assert.equal(store.canReplay(child), false);
});

test('fingerprint divergence is detected even when a later payload is not admitted', (t) => {
    const store = fixture(t).open();
    const original = completed(store);
    const retry = store.begin(scope, 'start', [], 9e15);
    store.observe(retry, observation('end', { admit: false, payloadFingerprint: 'other' }));
    store.resolve(retry);
    assert.equal(store.canReplay(original), false);
});

test('poisoned ancestors invalidate descendants and begin revalidates atomically', (t) => {
    const store = fixture(t).open();
    const ancestor = completed(store);
    const child = completed(store, 'child-start', 'child-end', [ancestor]);
    const competing = store.begin(scope, 'start', [], 9e15);
    assert.equal(store.canReplay(child), false);
    assert.throws(() => store.begin(scope, 'third-start', [ancestor, child], 9e15), /no longer safe/);
    store.poison(competing);
    assert.equal(store.canReplay(ancestor), false);
    assert.equal(store.canReplay(child), false);
    store.fence(scope.credential, scope.model, scope.caller);
    const fresh = publish(store, 'start', 'new-end');
    assert.equal(fresh.record, null);
    store.resolve(fresh.id);
});

test('typed start poison does not act as an end conflict with the same digest', (t) => {
    const store = fixture(t).open();
    const a = completed(store, 'safe-start', 'same-digest');
    store.poison(store.begin(scope, 'same-digest', [], 9e15));
    assert.equal(store.canReplay(a), true);
});

test('generation fences are credential/model/caller scoped and block in-flight publication', (t) => {
    const store = fixture(t).open();
    const otherScope = { ...scope, digest: 'other', caller: 'other-caller' };
    const a = completed(store);
    const b = completed(store, 'start', 'end', [], {}, otherScope);
    const pending = store.begin(scope, 'pending-start', [], 9e15);
    store.fence(scope.credential, scope.model, scope.caller);
    assert.equal(store.canReplay(a), false);
    assert.equal(store.canReplay(b), true);
    store.observe(pending, observation('pending-end'));
    store.resolve(pending);
    assert.equal(store.get(scope.digest, 'pending-end'), null);
    store.fence(scope.credential, scope.model);
    assert.equal(store.canReplay(b), false);
    assert.equal(store.ensureScope(scope), 3);
});

test('snapshots accept recent 24 hours plus last and inherit ancestor acceptance', (t) => {
    const f = fixture(t);
    const store = f.open();
    assert.equal(store.snapshotAccepted(scope.digest, 'unknown-before-observation'), true);
    const original = completed(store);
    const changed = completed(store, 'snapshot-start', 'snapshot-end', [original], { snapshot: 'model-2026-09-06' });
    assert.equal(store.ensureScope(scope), original.generation);
    assert.equal(store.canReplay(original), true);
    assert.equal(store.snapshotAccepted(scope.digest, original.snapshot), true);
    f.advance(2);
    assert.equal(store.snapshotAccepted(scope.digest, original.snapshot), false);
    assert.equal(store.snapshotAccepted(scope.digest, changed.snapshot), true);
    assert.equal(store.canReplay(changed), true);
    assert.throws(() => store.begin(scope, 'old-only', [original], 9e15), /snapshot/);
    store.resolve(store.begin(scope, 'inherited', [original, changed], 9e15));
    store.close();
    const reopened = f.open();
    assert.equal(reopened.snapshotAccepted(scope.digest, original.snapshot), false);
    assert.equal(reopened.snapshotAccepted(scope.digest, changed.snapshot), true);
    assert.equal(reopened.canReplay(changed), true);
});

test('restart transactionally poisons dispatch and delivery pending intents', (t) => {
    const f = fixture(t);
    const first = f.open();
    const a = completed(first);
    first.begin(scope, 'start', [], 9e15);
    const pending = publish(first, 'delivery-start', 'delivery-end');
    assert.ok(pending.record);
    first.close();
    const second = f.open();
    assert.equal(second.canReplay(a), false);
    assert.equal(second.canReplay(pending.record), false);
    second.close();
    assert.equal(inspect(f.options.path, 'SELECT count(*) AS n FROM intents')[0]?.n, 0);
    assert.equal(inspect(f.options.path, "SELECT count(*) AS n FROM markers WHERE kind = 'start-poison'")[0]?.n, 2);
});

test('unclean process exit recovers a committed pending intent', (t) => {
    const f = fixture(t);
    const options = { ...f.options, wallNow: undefined, monotonicNow: undefined };
    const script = `import {ReplayStore} from ${JSON.stringify(new URL('../src/reasoning/store.ts', import.meta.url).href)};
        const s=new ReplayStore(${JSON.stringify(options)}); s.begin(${JSON.stringify(scope)},'crash-start',[],9e15); process.exit(0);`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    const reopened = f.open();
    const { id, record } = publish(reopened, 'crash-start', 'crash-end');
    assert.equal(record, null);
    reopened.resolve(id);
});

test('coverage gaps persist before disabled traffic and fence all existing generations', (t) => {
    const f = fixture(t);
    assert.equal(markCoverageGapIfExists(f.options), false);
    assert.deepEqual(readdirSync(f.dir), []);
    const first = f.open();
    const a = completed(first);
    const otherScope = { ...scope, digest: 'other', credential: 'other-credential', model: 'other-model' };
    const b = completed(first, 'start', 'end', [], {}, otherScope);
    first.poison(first.begin(scope, 'poisoned', [], 9e15));
    first.markCoverageGap();
    assert.throws(() => first.begin(scope, 'disabled', [], 9e15), /disabled/);
    first.close();
    assert.equal(inspect(f.options.path, "SELECT value FROM metadata WHERE key = 'coverage-gap'")[0]?.value, '1');
    const second = f.open();
    assert.equal(second.canReplay(a), false);
    assert.equal(second.canReplay(b), false);
    const poisoned = publish(second, 'poisoned', 'poisoned-end');
    assert.equal(poisoned.record, null);
    second.resolve(poisoned.id);
    second.close();
    assert.equal(inspect(f.options.path, "SELECT value FROM metadata WHERE key = 'coverage-gap'").length, 0);
    assert.equal(markCoverageGapIfExists(f.options), true);
});

test('retention uses 30 idle days, touches ancestors, and preserves ledger after purge', (t) => {
    const f = fixture(t, { idleDays: 1 });
    const store = f.open();
    const ancestor = completed(store);
    f.advance(29);
    assert.equal(store.cleanup(), 0);
    const child = completed(store, 'child-start', 'child-end', [ancestor]);
    f.advance(2);
    assert.equal(store.cleanup(), 0);
    assert.ok(store.get(scope.digest, ancestor.endDigest));
    f.advance(29);
    assert.equal(store.cleanup(), 2);
    assert.equal(store.get(scope.digest, child.endDigest), null);
    const divergent = store.begin(scope, 'start', [], 9e15);
    store.observe(divergent, observation('end', { payloadFingerprint: 'different', output: output('different') }));
    store.resolve(divergent);
    assert.equal(store.get(scope.digest, 'end'), null);
    store.close();
    assert.equal(inspect(f.options.path, 'SELECT count(*) AS n FROM observations')[0]?.n, 2);
    assert.equal(inspect(f.options.path, "SELECT count(*) AS n FROM markers WHERE kind = 'end-conflict'")[0]?.n, 1);
});

test('active intents protect payloads and transitive dependencies from cleanup', (t) => {
    const f = fixture(t);
    const store = f.open();
    const ancestor = completed(store);
    const child = completed(store, 'child-start', 'child-end', [ancestor]);
    const pending = store.begin(scope, 'third-start', [ancestor, child], 9e15);
    f.advance(31);
    assert.equal(store.cleanup(), 0);
    store.resolve(pending);
    assert.equal(store.cleanup(), 2);
});

test('restart and wall clock jumps reset monotonic deletion barrier', (t) => {
    const f = fixture(t);
    const first = f.open();
    completed(first);
    f.advance(31);
    first.close();
    const store = f.open();
    assert.equal(store.cleanup(), 0);
    f.advance(29);
    f.jumpWall(100);
    assert.equal(store.cleanup(), 0);
    f.advance(29);
    assert.equal(store.cleanup(), 0);
    f.advance(2);
    assert.equal(store.cleanup(), 1);
});

test('backward wall and monotonic clock jumps conservatively reset retention', () => {
    let wall = 0;
    let mono = 0;
    const clock = new RetentionClock(30, () => wall, () => mono);
    wall = 31 * DAY_MS; mono = wall;
    assert.equal(clock.deletionCutoff(), DAY_MS);
    wall -= DAY_MS;
    assert.equal(clock.deletionCutoff(), null);
    wall += 31 * DAY_MS; mono += 31 * DAY_MS;
    assert.notEqual(clock.deletionCutoff(), null);
    mono = 0;
    assert.equal(clock.deletionCutoff(), null);
});

test('cleanup is bounded to 100 payloads and never purges observations', (t) => {
    const f = fixture(t);
    const store = f.open();
    for (let i = 0; i < 105; i++) completed(store, `start-${i}`, `end-${i}`);
    f.advance(31);
    assert.equal(store.cleanup(), 100);
    assert.equal(store.cleanup(), 5);
    store.close();
    assert.equal(inspect(f.options.path, 'SELECT count(*) AS n FROM observations')[0]?.n, 105);
});

test('quota rejection still observes and records conflicts without payloads', (t) => {
    const f = fixture(t, { diskBytes: 1 });
    const store = f.open();
    const initial = publish(store);
    store.resolve(initial.id);
    assert.equal(initial.record, null);
    const competing = publish(store, 'start', 'end', [], { payloadFingerprint: 'other', output: output('other') });
    store.resolve(competing.id);
    assert.equal(competing.record, null);
    assert.ok(statSync(`${f.options.path}.reserve`).blocks * 512 >= f.options.reserveBytes);
    store.close();
    assert.equal(inspect(f.options.path, 'SELECT count(*) AS n FROM observations')[0]?.n, 1);
    assert.equal(inspect(f.options.path, "SELECT count(*) AS n FROM markers WHERE kind = 'end-conflict'")[0]?.n, 1);
});

test('oversize and unknown envelopes poison positions rather than silently missing', (t) => {
    const f = fixture(t, { maxEntryBytes: 200 });
    const store = f.open();
    const large = publish(store, 'large-start', 'large-end', [], { output: output('x'.repeat(500)) });
    store.resolve(large.id);
    assert.equal(large.record, null);
    const retry = publish(store, 'large-start', 'retry-end');
    store.resolve(retry.id);
    assert.equal(retry.record, null);
    const unknown = publish(store, 'unknown-start', 'unknown-end', [], { endDigest: null, envelopeFingerprint: null, output: null, payloadFingerprint: null });
    store.resolve(unknown.id);
    assert.equal(unknown.record, null);
    store.close();
    assert.equal(inspect(f.options.path, "SELECT count(*) AS n FROM markers WHERE kind = 'start-poison'")[0]?.n, 2);
});

test('expire atomically poisons elapsed intents and renew extends their deadline', (t) => {
    const f = fixture(t);
    const store = f.open();
    const record = completed(store);
    const id = store.begin(scope, 'start', [], f.now() + 10);
    store.renew(id, f.now() + 100);
    store.expire(f.now() + 50);
    assert.equal(store.canReplay(record), false);
    store.expire(f.now() + 100);
    assert.equal(store.canReplay(record), false);
    assert.throws(() => store.renew(id, f.now() + 200), /Unknown/);
});

test('tampered records and cross-scope plans cannot begin a replay', (t) => {
    const store = fixture(t).open();
    const record = completed(store);
    assert.equal(store.canReplay({ ...record, output: output('tampered') }), false);
    assert.equal(store.canReplay({ ...record, payloadFingerprint: 'tampered' }), false);
    assert.throws(() => store.begin({ ...scope, digest: 'different' }, 'next', [record], 9e15), /scope mismatch/);
    assert.throws(() => store.ensureScope({ ...scope, credential: 'other' }), /identity mismatch/);
    const child = completed(store, 'child-start', 'child-end', [record]);
    assert.throws(() => store.begin(scope, 'next', [child], 9e15), /provenance mismatch/);
});

test('physical free-space exhaustion rejects payloads but commits observation and poison', (t) => {
    const f = fixture(t);
    const store = f.open();
    const id = store.begin(scope, 'start', [], 9e15);
    const prototype = StoreFiles.prototype;
    const availableBytes = prototype.availableBytes;
    prototype.availableBytes = () => 0;
    try {
        store.observe(id, observation());
        store.poison(id);
        assert.equal(store.get(scope.digest, 'end'), null);
        assert.throws(() => store.begin(scope, 'next', [], 9e15), /reserve exhausted/);
    } finally { prototype.availableBytes = availableBytes; }
    store.close();
    assert.equal(inspect(f.options.path, 'SELECT count(*) AS n FROM observations')[0]?.n, 1);
    assert.equal(inspect(f.options.path, "SELECT count(*) AS n FROM markers WHERE kind = 'start-poison'")[0]?.n, 1);
});

test('SQLite FULL releases reserve and retries the entire safety transaction', (t) => {
    const f = fixture(t);
    const store = f.open();
    const id = store.begin(scope, 'start', [], 9e15);
    const exec = DatabaseSync.prototype.exec;
    let injected = false;
    DatabaseSync.prototype.exec = function (sql: string) {
        if (sql === 'COMMIT' && !injected) {
            injected = true;
            throw Object.assign(new Error('database or disk is full'), { errcode: 13 });
        }
        return exec.call(this, sql);
    };
    try { store.poison(id); } finally { DatabaseSync.prototype.exec = exec; }
    assert.equal(injected, true);
    assert.equal(statSync(`${f.options.path}.reserve`).size, 0);
    assert.throws(() => store.begin(scope, 'next', [], 9e15), /reserve exhausted/);
    store.close();
    assert.equal(inspect(f.options.path, 'SELECT count(*) AS n FROM intents')[0]?.n, 0);
    assert.equal(inspect(f.options.path, "SELECT count(*) AS n FROM markers WHERE kind = 'start-poison'")[0]?.n, 1);
});

test('repeated safety commit failure durably blocks reopen and all future operations', (t) => {
    const f = fixture(t);
    const store = f.open();
    const id = store.begin(scope, 'start', [], 9e15);
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function (sql: string) {
        if (sql === 'COMMIT') throw Object.assign(new Error('database or disk is full'), { errcode: 13 });
        return exec.call(this, sql);
    };
    try {
        assert.throws(() => store.poison(id), /traffic must stop/);
    } finally { DatabaseSync.prototype.exec = exec; }
    assert.throws(() => store.get(scope.digest, 'end'), /failed/);
    store.close();
    assert.throws(() => f.open(), /manual recovery/);
    assert.equal(inspect(f.options.path, 'SELECT count(*) AS n FROM intents')[0]?.n, 1);
});

test('disk quota pressure does not evict active or recent payloads', (t) => {
    const f = fixture(t, { diskBytes: 256 * 1024, maxEntryBytes: 60 * 1024 });
    const store = f.open();
    const first = completed(store);
    let rejected = 0;
    for (let i = 0; i < 10; i++) {
        const result = publish(store, `start-${i}`, `end-${i}`, [], { output: output('x'.repeat(20_000)) });
        store.resolve(result.id);
        if (!result.record) rejected++;
    }
    assert.ok(rejected > 0);
    assert.equal(store.canReplay(first), true);
    assert.equal(store.cleanup(), 0);
});

test('begin never expires an active intent on a wall-clock jump', (t) => {
    const f = fixture(t);
    const store = f.open();
    const id = store.begin(scope, 'active-start', [], f.now() + 100);
    f.jumpWall(100);
    store.resolve(store.begin(scope, 'unrelated-start', [], f.now() + 100));
    store.renew(id, f.now() + 100);
    store.observe(id, observation('active-end'));
    store.resolve(id);
    assert.equal(store.canReplay(store.get(scope.digest, 'active-end')!), true);
});

test('fence poisons affected unresolved starts before bumping and preserves other callers', (t) => {
    const f = fixture(t);
    const store = f.open();
    const pending = store.begin(scope, 'fenced-position', [], 9e15);
    const otherScope = { ...scope, digest: 'other', caller: 'other' };
    const other = store.begin(otherScope, 'other-position', [], 9e15);
    store.fence(scope.credential, scope.model, scope.caller);
    store.observe(pending, observation('old-end'));
    store.resolve(pending);
    const newGeneration = publish(store, 'fenced-position', 'new-end');
    store.resolve(newGeneration.id);
    assert.equal(newGeneration.record, null);
    store.observe(other, observation('other-end'));
    store.resolve(other);
    assert.equal(store.canReplay(store.get(otherScope.digest, 'other-end')!), true);
    store.close();
    assert.equal(inspect(f.options.path, "SELECT count(*) n FROM markers WHERE kind = 'start-poison' AND digest = 'fenced-position'")[0]?.n, 1);
});

test('verified touches retain poisoned, ambiguous and bypassed matches with ancestors', (t) => {
    const f = fixture(t);
    const store = f.open();
    const ancestor = completed(store);
    const child = completed(store, 'child-start', 'child-end', [ancestor]);
    store.poison(store.begin(scope, 'start', [], 9e15));
    const conflict = publish(store, 'child-start', 'child-end', [], { output: output('conflict') });
    store.resolve(conflict.id);
    assert.equal(store.canReplay(child), false);
    f.advance(29);
    assert.equal(store.touchVerified(child), true);
    assert.equal(store.get(scope.digest, ancestor.endDigest)?.touchedAt, f.now());
    assert.equal(store.get(scope.digest, child.endDigest)?.touchedAt, f.now());
    const touchedAt = f.now();
    f.advance(1);
    assert.equal(store.touchVerified({ ...child, output: output('corrupted') }), false);
    assert.equal(store.touchVerified({ ...child, envelopeFingerprint: 'wrong' }), false);
    assert.equal(store.get(scope.digest, child.endDigest)?.touchedAt, touchedAt);
    f.advance(1);
    assert.equal(store.cleanup(), 0);
    f.advance(29);
    assert.equal(store.cleanup(), 2);
});

test('conflicting observations qualify as touches without making payload replayable', (t) => {
    const f = fixture(t);
    const store = f.open();
    const record = completed(store);
    f.advance(29);
    const conflicting = publish(store, 'start', 'end', [], { payloadFingerprint: 'different' });
    store.resolve(conflicting.id);
    assert.equal(store.canReplay(record), false);
    assert.equal(store.get(scope.digest, 'end')?.touchedAt, f.now());
    f.advance(2);
    assert.equal(store.cleanup(), 0);
});

test('high-depth provenance uses linear record loads per validation operation', (t) => {
    const f = fixture(t, { memoryBytes: 0, diskBytes: 64 * 1024 * 1024 });
    const store = f.open();
    const chain: ReplayRecord[] = [];
    for (let i = 0; i < 64; i++) chain.push(completed(store, `deep-start-${i}`, `deep-end-${i}`, [...chain]));
    const read = RecordReader.prototype.read;
    let loads = 0;
    RecordReader.prototype.read = function (...args: Parameters<typeof read>) { loads++; return read.apply(this, args); };
    try {
        assert.equal(store.canReplay(chain.at(-1)!), true);
        assert.equal(loads, chain.length);
        loads = 0;
        const id = store.begin(scope, 'deep-next', chain, 9e15);
        assert.equal(loads, chain.length);
        loads = 0;
        store.observe(id, observation('deep-next-end'));
        assert.ok(loads <= chain.length + 1, `loaded ${loads} records`);
        store.resolve(id);
    } finally { RecordReader.prototype.read = read; }
});

test('cumulative record and byte budgets fail closed without dispatch or partial touches', (t) => {
    const f = fixture(t);
    const first = f.open();
    const a = completed(first);
    const b = completed(first, 'b-start', 'b-end', [a]);
    const c = completed(first, 'c-start', 'c-end', [a, b]);
    first.close();
    f.options.maxPlanRecords = 2;
    const limited = f.open();
    assert.equal(limited.canReplay(c), false);
    assert.equal(limited.touchVerified(c), false);
    assert.throws(() => limited.begin(scope, 'next', [a, b, c], 9e15), /budget/);
    limited.close();
    f.options.maxPlanRecords = 256;
    f.options.maxReplayBytes = a.bytes - 1;
    const bytesLimited = f.open();
    assert.equal(bytesLimited.get(scope.digest, 'end'), null);
    assert.throws(() => bytesLimited.begin(scope, 'next', [a], 9e15), /safe|budget/);
});

test('oversized or corrupt stored JSON is rejected before payload fetch and parse', (t) => {
    const f = fixture(t);
    const store = f.open();
    completed(store);
    store.close();
    const db = new DatabaseSync(f.options.path);
    t.after(() => db.close());
    const reader = new RecordReader(db, f.options);
    db.prepare("UPDATE payloads SET output_json = ?, bytes = ? WHERE end_digest = 'end'")
        .run('x'.repeat(f.options.maxEntryBytes + 1), f.options.maxEntryBytes + 1);
    const prepare = DatabaseSync.prototype.prepare;
    let payloadFetches = 0;
    DatabaseSync.prototype.prepare = function (sql: string) {
        if (sql.includes('SELECT o.*, p.output_json')) payloadFetches++;
        return prepare.call(this, sql);
    };
    try {
        assert.equal(reader.validation().load(scope.digest, 'end'), null);
        assert.equal(payloadFetches, 0);
        db.prepare("UPDATE payloads SET output_json = '[]', bytes = 2 WHERE end_digest = 'end'").run();
        db.prepare("UPDATE observations SET prior_plan = ? WHERE end_digest = 'end'")
            .run('x'.repeat(reader.maxPlanBytes + 1));
        assert.equal(reader.validation().load(scope.digest, 'end'), null);
        assert.equal(payloadFetches, 0);
        db.prepare("UPDATE observations SET prior_plan = '[]', snapshot = ? WHERE end_digest = 'end'").run('x'.repeat(8193));
        assert.equal(reader.validation().load(scope.digest, 'end'), null);
        assert.equal(payloadFetches, 0);
    } finally { DatabaseSync.prototype.prepare = prepare; }
});

test('hot cache is wired, frozen, bounded, and checks persisted row versions', (t) => {
    const f = fixture(t);
    const store = f.open();
    completed(store);
    const first = store.get(scope.digest, 'end')!;
    assert.equal(store.get(scope.digest, 'end'), first);
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.output[0]));
    assert.throws(() => { first.output[0]!.encrypted_content = 'tampered'; }, TypeError);
    f.advance(1);
    assert.equal(store.touchVerified(first), true);
    const touched = store.get(scope.digest, 'end')!;
    assert.notEqual(touched, first);
    assert.equal(touched.touchedAt, f.now());
    store.close();
    const db = new DatabaseSync(f.options.path);
    t.after(() => db.close());
    const reader = new RecordReader(db, f.options);
    const cached = reader.validation().load(scope.digest, 'end')!;
    db.prepare("UPDATE observations SET snapshot = 'new-snapshot' WHERE end_digest = 'end'").run();
    const fresh = reader.validation().load(scope.digest, 'end')!;
    assert.notEqual(fresh, cached);
    assert.equal(fresh.snapshot, 'new-snapshot');
    db.prepare("UPDATE payloads SET output_json = replace(output_json, 'answer', 'broken') WHERE end_digest = 'end'").run();
    assert.equal(reader.validation().load(scope.digest, 'end'), null);
});

test('store hot cache uses serialized sizes and refuses over-budget entries', (t) => {
    const f = fixture(t, { memoryBytes: 1 });
    const store = f.open();
    completed(store);
    assert.notEqual(store.get(scope.digest, 'end'), store.get(scope.digest, 'end'));
    store.close();
    const db = new DatabaseSync(f.options.path);
    t.after(() => db.close());
    const size = Number(db.prepare(`SELECT octet_length(p.output_json) + octet_length(o.prior_plan)
        + octet_length(o.scope) + octet_length(o.end_digest) + octet_length(o.start_digest)
        + octet_length(o.payload_fingerprint) + octet_length(o.output_hash) + octet_length(o.envelope_fingerprint)
        + octet_length(o.producing_intent_id) + octet_length(o.snapshot) size
        FROM observations o JOIN payloads p USING(scope, end_digest)`).get()!.size);
    const exact = new RecordReader(db, { ...f.options, memoryBytes: size });
    assert.equal(exact.validation().load(scope.digest, 'end'), exact.validation().load(scope.digest, 'end'));
    const tooSmall = new RecordReader(db, { ...f.options, memoryBytes: size - 1 });
    assert.notEqual(tooSmall.validation().load(scope.digest, 'end'), tooSmall.validation().load(scope.digest, 'end'));
});

test('descriptor array count is checked before JSON.parse allocates stored provenance', (t) => {
    const f = fixture(t);
    const store = f.open();
    completed(store);
    store.close();
    const db = new DatabaseSync(f.options.path);
    t.after(() => db.close());
    db.prepare("UPDATE observations SET prior_plan = '[{},{},{}]' WHERE end_digest = 'end'").run();
    const reader = new RecordReader(db, { ...f.options, maxPlanRecords: 2 });
    const parse = JSON.parse;
    let parsedOversizePlan = false;
    JSON.parse = ((text: string, ...args: unknown[]) => {
        if (text === '[{},{},{}]') parsedOversizePlan = true;
        return Reflect.apply(parse, JSON, [text, ...args]);
    }) as typeof JSON.parse;
    try {
        assert.equal(reader.validation().load(scope.digest, 'end'), null);
        assert.equal(parsedOversizePlan, false);
    } finally { JSON.parse = parse; }
});

test('cumulative payload bytes are charged once per record and bounded across the full plan', (t) => {
    const f = fixture(t);
    const first = f.open();
    const a = completed(first, 'a-start', 'a-end', [], { output: output('a'.repeat(3000)) });
    const b = completed(first, 'b-start', 'b-end', [a], { output: output('b'.repeat(3000)) });
    first.close();
    f.options.maxReplayBytes = Math.max(a.bytes, b.bytes) + 500;
    const limited = f.open();
    assert.ok(limited.get(scope.digest, 'a-end'));
    assert.ok(limited.get(scope.digest, 'b-end'));
    assert.equal(limited.canReplay(b), false);
    assert.equal(limited.touchVerified(b), false);
    assert.throws(() => limited.begin(scope, 'next', [a, b], 9e15), /safe/);
});

test('repeated ancestry metadata does not consume the distinct serialized payload budget', (t) => {
    const f = fixture(t, { diskBytes: 64 * 1024 * 1024 });
    const store = f.open();
    const chain: ReplayRecord[] = [];
    for (let i = 0; i < 40; i++) {
        chain.push(completed(store, `serialized-start-${i}`, `serialized-end-${i}`, [...chain], { output: output('x'.repeat(128)) }));
    }
    const payloadBytes = chain.reduce((sum, record) => sum + record.bytes, 0);
    const ancestryBytes = chain.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record.priorPlan)), 0);
    assert.ok(ancestryBytes > payloadBytes);
    store.close();
    f.options.maxReplayBytes = payloadBytes;
    const exact = f.open();
    assert.equal(exact.canReplay(chain.at(-1)!), true);
    exact.resolve(exact.begin(scope, 'exact-budget', chain, 9e15));
    exact.close();
    f.options.maxReplayBytes = payloadBytes - 1;
    const below = f.open();
    assert.equal(below.canReplay(chain.at(-1)!), false);
    assert.throws(() => below.begin(scope, 'below-budget', chain, 9e15), /safe/);
});

test('planning validation cannot escape its transaction or hide later poison and forged records', async (t) => {
    const store = fixture(t).open();
    const record = completed(store);
    let escaped: ReplayPlanningStore | undefined;
    store.withPlanning((planning) => {
        escaped = planning;
        assert.equal(planning.canReplay(record), true);
        assert.equal(planning.canReplay({ ...record, output: output('forged') }), false);
        assert.equal(planning.touchVerified({ ...record, priorPlan: [record] }), false);
        assert.throws(() => store.bypass(scope, record.startDigest), /transaction already active/);
        assert.equal(planning.canReplay(record), true);
        return [];
    });
    await Promise.resolve();
    assert.throws(() => escaped!.canReplay(record), /expired/);
    assert.throws(() => escaped!.get(scope.digest, record.endDigest), /expired/);
    store.bypass(scope, record.startDigest);
    store.withPlanning((planning) => {
        assert.equal(planning.canReplay(record), false);
        assert.equal(planning.touchVerified(record), true);
        return [];
    });
    assert.throws(() => store.begin(scope, 'fresh-dispatch', [record], 9e15), /no longer safe/);
});

test('cached valid roots never bypass exact ancestry-prefix consistency for another root', (t) => {
    const f = fixture(t);
    const store = f.open();
    const a = completed(store, 'a-start', 'a-end');
    const sibling = completed(store, 'sibling-start', 'sibling-end');
    const b = completed(store, 'b-start', 'b-end', [a]);
    const c = completed(store, 'c-start', 'c-end', [a, b]);
    store.close();
    const db = new DatabaseSync(f.options.path);
    t.after(() => db.close());
    db.prepare('UPDATE observations SET prior_plan = ? WHERE end_digest = ?').run(JSON.stringify([{
        startDigest: sibling.startDigest, endDigest: sibling.endDigest, payloadFingerprint: sibling.payloadFingerprint,
    }]), b.endDigest);
    const validation = new RecordReader(db, f.options).validation();
    const changed = validation.load(scope.digest, b.endDigest)!;
    assert.equal(validation.validate(changed), true);
    assert.equal(validation.validate(c, false), false);
    assert.equal(validation.validate(c), false);
    assert.equal(validation.validate(a), true);
});

test('a failed root does not suppress an independent valid planning fallback', (t) => {
    const store = fixture(t).open();
    const blocked = completed(store, 'blocked-start', 'blocked-end');
    const safe = completed(store, 'safe-start', 'safe-end');
    store.bypass(scope, blocked.startDigest);
    store.withPlanning((planning) => {
        assert.equal(planning.canReplay(blocked), false);
        assert.equal(planning.canReplay(safe), true);
        return [safe];
    });
});

test('cleanup protects unresolved same-position competitors even without replay dependencies', (t) => {
    const f = fixture(t);
    const store = f.open();
    completed(store);
    const pending = store.begin(scope, 'start', [], 9e15);
    f.advance(31);
    assert.equal(store.cleanup(), 0);
    store.resolve(pending);
    assert.equal(store.cleanup(), 1);
});

test('schema v1 migrates row versions and snapshot registry without losing payloads', (t) => {
    const f = fixture(t);
    const store = f.open();
    const record = completed(store);
    store.close();
    const db = new DatabaseSync(f.options.path);
    try {
        db.exec(`DROP TRIGGER observations_version_insert; DROP TRIGGER observations_version_update;
            DROP TRIGGER payloads_version_insert; DROP TRIGGER payloads_version_update;
            ALTER TABLE observations DROP COLUMN row_version; ALTER TABLE payloads DROP COLUMN row_version;
            DROP TABLE snapshots; UPDATE metadata SET value = '1' WHERE key = 'schema-version';`);
    } finally { db.close(); }
    const reopened = f.open();
    assert.equal(reopened.canReplay(record), true);
    assert.equal(reopened.snapshotAccepted(scope.digest, record.snapshot), true);
    assert.equal(reopened.touchVerified(record), true);
});
