import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
    statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { INSPECTION_BACKUP_PAGES, INSPECTION_MIN_FREE_BYTES } from '../src/reasoning/inspection.ts';
import type { InspectionOptions } from '../src/reasoning/inspection.ts';
import { DAY_MS, MIN_IDLE_MS, RetentionClock } from '../src/reasoning/retention.ts';
import { ReplayStore } from '../src/reasoning/store.ts';
import type { StoreOptions } from '../src/reasoning/types.ts';

const identity = { digest: 'private-scope-digest', credential: 'private-credential', model: 'private-model', caller: 'private-user' };
const tableNames = ['metadata', 'scopes', 'snapshots', 'markers', 'intents', 'observations', 'payloads', 'dependencies', 'intent_dependencies'];
const privateDb = (store: ReplayStore) => (store as unknown as { db: DatabaseSync }).db;
const dump = (db: DatabaseSync) => tableNames.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
const changes = (db: DatabaseSync) => Number(db.prepare('SELECT total_changes() AS n').get()!.n);
const sourceFiles = (path: string) => ['', '-wal', '-shm', '.reserve', '.guard', '.secret'].map((suffix) => {
    const file = path + suffix;
    return existsSync(file) ? { bytes: readFileSync(file), mtime: statSync(file).mtimeMs } : null;
});

function fixture(t: TestContext, inspection: InspectionOptions = {}, overrides: Partial<StoreOptions> = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'relay-inspection-test-'));
    let wall = 1_800_000_000_000;
    let monotonic = 0;
    let clockReads = 0;
    const options: StoreOptions = { path: join(directory, 'store.sqlite'), idleDays: 30, diskBytes: 64 * 1024 * 1024,
        reserveBytes: 65_536, memoryBytes: 1024 * 1024, maxEntryBytes: 2 * 1024 * 1024,
        wallNow: () => { clockReads++; return wall; }, monotonicNow: () => { clockReads++; return monotonic; }, ...overrides };
    const store = new ReplayStore(options, inspection);
    t.after(async () => { await store.waitForInspection(); store.close(); rmSync(directory, { force: true, recursive: true }); });
    return { store, options, directory, db: privateDb(store), clockReads: () => clockReads,
        advance: (days: number) => { wall += days * DAY_MS; monotonic += days * DAY_MS; } };
}

function publish(store: ReplayStore, suffix = 'first', size = 20): string {
    const intent = store.begin(identity, `private-start-${suffix}`, [], 9e15);
    store.observe(intent, { endDigest: `private-end-${suffix}`, envelopeFingerprint: `private-envelope-${suffix}`,
        output: [{ type: 'reasoning', encrypted_content: 'private-payload'.padEnd(size, 'x') }],
        payloadFingerprint: `private-fingerprint-${suffix}`, snapshot: 'private-upstream-snapshot', admit: true, deliveryDeadline: 9e15 });
    return intent;
}

function readSnapshot(path: string) {
    const db = new DatabaseSync(`file:${path}?immutable=1`, { readOnly: true });
    try {
        assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        return dump(db);
    } finally { db.close(); }
}

test('retention status uses only the last validated sample without reading clocks or resetting barriers', () => {
    let wall = 1_800_000_000_000;
    let monotonic = 0;
    let reads = 0;
    const clock = new RetentionClock(45, () => { reads++; return wall; }, () => { reads++; return monotonic; });
    const initial = clock.status();
    assert.equal(initial.idleMs, 45 * DAY_MS);
    assert.equal(initial.barrierRemainingMs, MIN_IDLE_MS);
    wall += 31 * DAY_MS;
    monotonic += 31 * DAY_MS;
    assert.deepEqual(clock.status(), initial);
    assert.equal(reads, 2);
    clock.now();
    assert.equal(clock.status().barrierActive, false);
    const last = clock.status();
    wall -= 10 * DAY_MS;
    assert.deepEqual(clock.status(), last);
    assert.equal(reads, 4);
    clock.now();
    assert.equal(clock.status().barrierRemainingMs, MIN_IDLE_MS);
});

test('inspect returns metadata only and neither samples retention nor mutates source records or files', (t) => {
    const f = fixture(t);
    publish(f.store);
    f.store.begin(identity, 'private-unresolved', [], 0);
    f.store.bypass(identity, 'private-poison');
    f.advance(40);
    const before = dump(f.db);
    const beforeFiles = sourceFiles(f.options.path);
    const beforeChanges = changes(f.db);
    const reads = f.clockReads();
    const status = f.store.inspect();
    assert.equal(status.state, 'ready');
    assert.equal(status.enabled, true);
    assert.equal(status.retention.barrierActive, true);
    assert.equal(status.retention.basis, 'last-validated-sample');
    assert.equal(f.clockReads(), reads);
    assert.deepEqual(status.metrics!.counts.scopes, { value: 1, accuracy: 'exact' });
    assert.equal(status.metrics!.counts.observations.value, 1);
    assert.equal(status.metrics!.counts.payloads.value, 1);
    assert.equal(status.metrics!.counts.markers.value, 1);
    assert.deepEqual(status.metrics!.intentsByPhase, {
        dispatch: { value: 1, accuracy: 'exact' }, delivery: { value: 1, accuracy: 'exact' },
    });
    assert.equal(status.metrics!.payloadSerializedBytes.value, Number(f.db.prepare('SELECT bytes FROM payloads').get()!.bytes));
    assert.equal(status.metrics!.physical.database!.bytes, statSync(f.options.path).size);
    assert.equal(status.metrics!.physical.wal!.bytes, statSync(`${f.options.path}-wal`).size);
    assert.equal(status.metrics!.physical.reserve!.allocatedBytes, statSync(`${f.options.path}.reserve`).blocks * 512);
    const serialized = JSON.stringify(status);
    for (const secret of [...Object.values(identity), 'private-', f.store.secret, f.options.path]) assert.ok(!serialized.includes(secret));
    assert.ok(Object.isFrozen(status.metrics!.counts.scopes));
    assert.deepEqual(dump(f.db), before);
    assert.deepEqual(sourceFiles(f.options.path), beforeFiles);
    assert.equal(changes(f.db), beforeChanges);
});

test('metrics use one bounded scan per table and remain cached for five seconds across producer writes', (t) => {
    let now = 0;
    const f = fixture(t, { monotonicNow: () => now, wallNow: () => 1234 });
    let scans = 0;
    const prepare = f.db.prepare;
    f.db.prepare = function (sql) { if (sql.startsWith('SELECT')) scans++; return prepare.call(this, sql); };
    const first = f.store.inspect();
    assert.equal(scans, tableNames.length);
    assert.equal(first.metrics!.sampledAt, 1234);
    f.store.ensureScope(identity);
    const beforeCached = scans;
    now = 4999;
    assert.equal(f.store.inspect().metrics, first.metrics);
    assert.equal(scans, beforeCached);
    now = 5000;
    assert.equal(f.store.inspect().metrics!.counts.scopes.value, 1);
    assert.equal(scans, beforeCached + tableNames.length);
});

test('large tables report 10001-row lower bounds and explicitly bounded payload byte totals and phases', (t) => {
    const f = fixture(t);
    f.db.exec(`BEGIN IMMEDIATE;
        WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10005)
        INSERT INTO scopes(digest,credential,model,caller) SELECT CAST(x AS TEXT),'credential','model','user' FROM n;
        INSERT INTO observations(scope,end_digest,start_digest,payload_fingerprint,envelope_fingerprint,prior_plan,
            generation,producing_intent_id,snapshot,replayable,created_at)
            SELECT digest,'end','start','fingerprint','envelope','[]',1,'producer','snapshot',1,0 FROM scopes;
        INSERT INTO payloads(scope,end_digest,output_json,touched_at,bytes) SELECT digest,'end','[]',0,2 FROM scopes;
        INSERT INTO markers(scope,kind,digest,created_at) SELECT digest,'start-poison','start',0 FROM scopes;
        INSERT INTO intents(id,scope,generation,start_digest,prior_plan,deadline,phase)
            SELECT digest,digest,1,'start','[]',0,CASE WHEN CAST(digest AS INTEGER)%2=0 THEN 'dispatch' ELSE 'delivery' END FROM scopes;
        INSERT INTO snapshots(scope,snapshot,seen_at) SELECT digest,'snapshot',0 FROM scopes;
        INSERT INTO dependencies(scope,child_end,ancestor_end) SELECT digest,'end','end' FROM scopes;
        INSERT INTO intent_dependencies(intent_id,scope,end_digest) SELECT digest,digest,'end' FROM scopes;
        INSERT INTO metadata(key,value) SELECT 'test-'||digest,'private' FROM scopes;
        COMMIT;`);
    const metrics = f.store.inspect().metrics!;
    for (const table of tableNames) assert.deepEqual(metrics.counts[table as keyof typeof metrics.counts], { value: 10001, accuracy: 'lower-bound' });
    assert.equal(metrics.intentsByPhase.dispatch.accuracy, 'lower-bound');
    assert.equal(metrics.intentsByPhase.delivery.accuracy, 'lower-bound');
    assert.equal(metrics.intentsByPhase.dispatch.value + metrics.intentsByPhase.delivery.value, 10001);
    assert.deepEqual(metrics.payloadSerializedBytes, { value: 20002, sampledRows: 10001,
        accuracy: 'lower-bound', basis: 'bounded-stored-serialized-bytes' });
});

test('disabled, failed, and closed status never trips assertEnabled or performs recovery writes', async (t) => {
    const f = fixture(t);
    f.store.markCoverageGap();
    const before = dump(f.db);
    assert.equal(f.store.inspect().state, 'disabled');
    assert.equal(f.store.inspect().coverageGap, true);
    assert.equal(f.store.inspect().enabled, false);
    assert.deepEqual(dump(f.db), before);
    const snapshot = await f.store.createInspectionSnapshot();
    assert.deepEqual(readSnapshot(snapshot.path), before);
    (f.store as unknown as { failed: boolean }).failed = true;
    assert.equal(f.store.inspect().state, 'failed');
    assert.equal(f.store.inspect().metricsAvailable, false);
    await assert.rejects(f.store.createInspectionSnapshot(), /closed or failed/);
    f.store.close();
    assert.equal(f.store.inspect().state, 'closed');
    await assert.rejects(f.store.createInspectionSnapshot(), /closed or failed/);
});

test('native snapshot preserves source data, touches, clock, files and exclusive lock with private immutable output', async (t) => {
    let source: DatabaseSync | undefined;
    const f = fixture(t, { backup: async (db, path, options) => {
        source = db;
        assert.equal(options!.rate, INSPECTION_BACKUP_PAGES);
        assert.equal(statSync(path).mode & 0o777, 0o600);
        assert.equal(statSync(dirname(String(path))).mode & 0o777, 0o700);
        assert.equal(statSync(dirname(dirname(String(path)))).mode & 0o777, 0o700);
        assert.throws(() => new ReplayStore({ ...f.options, wallNow: Date.now, monotonicNow: () => 0 }), /locked/);
        return backup(db, path, options);
    } });
    publish(f.store);
    const before = dump(f.db);
    const files = sourceFiles(f.options.path);
    const reads = f.clockReads();
    const beforeChanges = changes(f.db);
    const result = await f.store.createInspectionSnapshot();
    assert.equal(source, f.db);
    assert.equal(result.inspectionOnly, true);
    assert.ok(result.pages > 0);
    assert.equal(result.bytes, statSync(result.path).size);
    assert.equal(result.bytes, result.pages * Number(f.db.prepare('PRAGMA page_size').get()!.page_size));
    assert.ok(Object.isFrozen(result));
    assert.equal(statSync(result.path).mode & 0o777, 0o400);
    assert.deepEqual(readdirSync(dirname(result.path)), ['snapshot.sqlite']);
    assert.equal(existsSync(`${result.path}.secret`), false);
    assert.deepEqual(readSnapshot(result.path), before);
    assert.deepEqual(readdirSync(dirname(result.path)), ['snapshot.sqlite']);
    assert.throws(() => new ReplayStore({ ...f.options, path: result.path, wallNow: Date.now, monotonicNow: () => 0 }), /missing its secret/);
    assert.throws(() => new ReplayStore({ ...f.options, wallNow: Date.now, monotonicNow: () => 0 }), /locked/);
    assert.deepEqual(dump(f.db), before);
    assert.deepEqual(sourceFiles(f.options.path), files);
    assert.equal(changes(f.db), beforeChanges);
    assert.equal(f.clockReads(), reads);
    assert.equal(f.db.prepare('PRAGMA locking_mode').get()!.locking_mode, 'exclusive');
});

test('native page-batched backup remains consistent while the same owner writes and inspects', async (t) => {
    let progressCalls = 0;
    let expected: ReturnType<typeof dump> | undefined;
    let expectedChanges = 0;
    const f = fixture(t, { backup: (db, path, options) => backup(db, path, { ...options, progress: (progress) => {
        progressCalls++;
        if (progressCalls === 1) {
            assert.ok(progress.remainingPages > 0);
            const id = publish(f.store, 'during-backup');
            f.store.resolve(id);
            f.store.bypass(identity, 'producer-marker');
            expected = dump(db);
            expectedChanges = changes(db);
            assert.equal(f.store.inspect().snapshotPending, true);
            assert.throws(() => new ReplayStore({ ...f.options, wallNow: Date.now, monotonicNow: () => 0 }), /locked/);
        }
        options!.progress!(progress);
    } }) });
    publish(f.store, 'large', 1024 * 1024);
    const result = await f.store.createInspectionSnapshot();
    assert.ok(progressCalls > 1);
    assert.deepEqual(readSnapshot(result.path), expected);
    assert.deepEqual(dump(f.db), expected);
    assert.equal(changes(f.db), expectedChanges);
});

test('single pending snapshot rejects concurrency and close while shutdown waits for completion', async (t) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = fixture(t, { backup: async (db, path, options) => { await gate; return backup(db, path, options); } });
    const pending = f.store.createInspectionSnapshot();
    assert.equal(f.store.inspect().snapshotPending, true);
    await assert.rejects(f.store.createInspectionSnapshot(), /already in progress/);
    assert.throws(() => f.store.close(), /waitForInspection/);
    f.store.ensureScope(identity);
    let settled = false;
    const waiting = f.store.waitForInspection().then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    release();
    await pending;
    await waiting;
    assert.equal(settled, true);
    assert.equal(f.store.inspect().snapshotPending, false);
    f.store.close();
});

test('backup errors remove partial files, preserve the live cache and allow retry and shutdown', async (t) => {
    let fail = true;
    const f = fixture(t, { backup: async (db, path, options) => {
        if (fail) { writeFileSync(path, 'partial'); throw new Error('injected backup failure'); }
        return backup(db, path, options);
    } });
    publish(f.store);
    const before = dump(f.db);
    const pending = f.store.createInspectionSnapshot();
    const rejected = assert.rejects(pending, /injected backup failure/);
    await f.store.waitForInspection();
    await rejected;
    assert.deepEqual(readdirSync(join(f.directory, 'inspection')), []);
    assert.equal(f.store.inspect().state, 'ready');
    assert.equal(existsSync(`${f.options.path}.blocked`), false);
    assert.deepEqual(dump(f.db), before);
    fail = false;
    const result = await f.store.createInspectionSnapshot();
    assert.deepEqual(readSnapshot(result.path), before);
    const next = await f.store.createInspectionSnapshot();
    assert.notEqual(next.path, result.path);
    assert.equal(existsSync(result.path), true);
    assert.deepEqual(readSnapshot(result.path), before);
    assert.deepEqual(new Set(readdirSync(join(f.directory, 'inspection'))),
        new Set([dirname(result.path).split('/').at(-1), dirname(next.path).split('/').at(-1)]));
});

test('returned snapshots survive later snapshots and source-owner restarts', async (t) => {
    const f = fixture(t);
    const first = await f.store.createInspectionSnapshot();
    f.store.close();
    const nextOwner = new ReplayStore(f.options);
    try {
        const second = await nextOwner.createInspectionSnapshot();
        assert.equal(existsSync(first.path), true);
        assert.equal(existsSync(second.path), true);
        assert.equal(readdirSync(join(f.directory, 'inspection')).length, 2);
    } finally { await nextOwner.waitForInspection(); nextOwner.close(); }
});

test('initial capacity checks protect 64MiB free space and the configurable total source-size limit', async (t) => {
    let calls = 0;
    const f = fixture(t, { availableBytes: () => INSPECTION_MIN_FREE_BYTES,
        backup: async () => { calls++; throw new Error('must not run'); } });
    await assert.rejects(f.store.createInspectionSnapshot(), /Insufficient free space/);
    assert.equal(calls, 0);
    assert.equal(existsSync(join(f.directory, 'inspection')), false);
    assert.equal(f.store.inspect().state, 'ready');
    const small = fixture(t, { maxSourceBytes: 1 });
    await assert.rejects(small.store.createInspectionSnapshot(), /size limit/);
    assert.equal(existsSync(join(small.directory, 'inspection')), false);
});

test('native progress failure aborts and cleans up without poisoning the owner', async (t) => {
    let free = Number.MAX_SAFE_INTEGER;
    const f = fixture(t, { availableBytes: () => free, backup: (db, path, options) => backup(db, path, {
        ...options, progress: (progress) => { free = 0; options!.progress!(progress); },
    }) });
    publish(f.store, 'large', 1024 * 1024);
    const before = dump(f.db);
    await assert.rejects(f.store.createInspectionSnapshot(), /Insufficient free space/);
    await f.store.waitForInspection();
    assert.deepEqual(readdirSync(join(f.directory, 'inspection')), []);
    assert.deepEqual(dump(f.db), before);
    assert.equal(f.store.inspect().state, 'ready');
});

test('snapshots reject existing transactions including ones begun before deferred backup starts', async (t) => {
    const f = fixture(t);
    f.db.exec('BEGIN IMMEDIATE');
    await assert.rejects(f.store.createInspectionSnapshot(), /active database transaction/);
    assert.equal(f.db.isTransaction, true);
    f.db.exec('ROLLBACK');
    const pending = f.store.createInspectionSnapshot();
    f.db.exec('BEGIN IMMEDIATE');
    await assert.rejects(pending, /active database transaction/);
    f.db.exec('ROLLBACK');
    assert.equal(f.store.inspect().state, 'ready');
});

test('snapshot directory creation rejects symlinks and unsafe existing parents without changing them', async (t) => {
    const f = fixture(t);
    const elsewhere = join(f.directory, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    const root = join(f.directory, 'inspection');
    symlinkSync(elsewhere, root);
    await assert.rejects(f.store.createInspectionSnapshot(), /Unsafe inspection directory/);
    assert.ok(lstatSync(root).isSymbolicLink());
    assert.deepEqual(readdirSync(elsewhere), []);
    rmSync(root);
    mkdirSync(root, { mode: 0o755 });
    await assert.rejects(f.store.createInspectionSnapshot(), /Unsafe inspection directory/);
    assert.equal(statSync(root).mode & 0o777, 0o755);
    chmodSync(root, 0o700);
    chmodSync(f.directory, 0o755);
    await assert.rejects(f.store.createInspectionSnapshot(), /Unsafe inspection directory/);
    assert.equal(statSync(f.directory).mode & 0o777, 0o755);
    chmodSync(f.directory, 0o700);
    const unexpected = join(root, 'do-not-delete');
    writeFileSync(unexpected, 'private unrelated contents', { mode: 0o600 });
    const result = await f.store.createInspectionSnapshot();
    assert.equal(existsSync(result.path), true);
    assert.equal(readFileSync(unexpected, 'utf8'), 'private unrelated contents');
    assert.equal(f.store.inspect().state, 'ready');
});

test('private export destination works independently of group-writable source ancestors', async (t) => {
    const f = fixture(t);
    const shared = join(f.directory, 'checkout');
    mkdirSync(shared, { mode: 0o775 }); chmodSync(shared, 0o775);
    const source = join(shared, 'data'); mkdirSync(source, { mode: 0o700 });
    const destination = join(f.directory, 'private-exports');
    const owner = new ReplayStore({ ...f.options, path: join(source, 'cache.sqlite') }, { directory: destination });
    try {
        const result = await owner.createInspectionSnapshot();
        assert.ok(result.path.startsWith(destination + '/'));
        assert.equal(statSync(shared).mode & 0o777, 0o775);
        assert.equal(statSync(destination).mode & 0o777, 0o700);
        assert.equal(existsSync(join(source, 'inspection')), false);
    } finally { await owner.waitForInspection(); owner.close(); }
});

test('inspection read failures are cached and do not fail the live store', (t) => {
    let now = 0;
    const f = fixture(t, { monotonicNow: () => now });
    let failures = 0;
    const prepare = f.db.prepare;
    f.db.prepare = function (sql) {
        if (sql.includes('SELECT count(*) AS value')) { failures++; throw new Error('injected inspection failure'); }
        return prepare.call(this, sql);
    };
    assert.equal(f.store.inspect().metricsAvailable, false);
    assert.equal(f.store.inspect().metricsAvailable, false);
    assert.equal(failures, 1);
    assert.equal(f.store.inspect().state, 'ready');
    f.db.prepare = prepare;
    f.store.ensureScope(identity);
    now = 5000;
    assert.equal(f.store.inspect().metrics!.counts.scopes.value, 1);
});
