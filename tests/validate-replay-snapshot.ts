// Explicit offline validation of an existing immutable inspection copy; no live DB/secret access.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { RecordReader } from '../src/reasoning/store-records.ts';
import { loadCacheConfig } from '../src/reasoning/config.ts';
import { canonicalFingerprint } from '../src/reasoning/canonical.ts';

const path = process.argv[2];
assert.ok(path && path.endsWith('/snapshot.sqlite'), 'Explicit completed inspection snapshot required');
const snapshotPath = resolve(path);
assert.equal((await stat(snapshotPath)).mode & 0o777, 0o400, 'Use an immutable owner-read-only inspection export');
const hash = async () => createHash('sha256').update(await readFile(snapshotPath)).digest('hex');
const before = await hash();
const uri = pathToFileURL(snapshotPath); uri.searchParams.set('immutable', '1');
const db = new DatabaseSync(uri.href, { readOnly: true, timeout: 0 });
try {
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const config = loadCacheConfig({});
    const options = { path: 'inspection-only', idleDays: config.idleDays, diskBytes: config.diskBytes,
        reserveBytes: config.reserveBytes, memoryBytes: 0, maxEntryBytes: config.maxEntryBytes,
        maxReplayBytes: config.maxReplayBytes, maxPlanRecords: config.maxPlanRecords };
    const rows = db.prepare('SELECT o.scope,o.end_digest,o.payload_fingerprint,p.output_json FROM observations o JOIN payloads p USING(scope,end_digest)').all();
    const reader = new RecordReader(db, options);
    let passed = 0; let longest = 0; let largest = 0;
    const started = performance.now();
    for (const row of rows) {
        const record = reader.validation().load(String(row.scope), String(row.end_digest));
        assert.ok(record, 'Payload must be readable at configured serialized limits');
        assert.equal(canonicalFingerprint(JSON.parse(String(row.output_json))), row.payload_fingerprint);
        const validation = reader.validation();
        assert.ok(validation.validate(record), 'Known structurally valid snapshot chain must pass full validation');
        passed++;
        longest = Math.max(longest, record.priorPlan.length);
        largest = Math.max(largest, validation.records().reduce((total, item) => total + item.bytes, 0));
    }
    let previousPassed: number | null = null;
    if (process.env.BASELINE_READER) {
        const baseline = await import(pathToFileURL(resolve(process.env.BASELINE_READER)).href) as { RecordReader: typeof RecordReader };
        const previous = new baseline.RecordReader(db, { ...options, maxReplayBytes: 262144 });
        previousPassed = 0;
        for (const row of rows) {
            const record = previous.validation().load(String(row.scope), String(row.end_digest));
            if (record && previous.validation().validate(record)) previousPassed++;
        }
        previous.clear();
    }
    reader.clear();
    assert.equal(await hash(), before, 'Inspection must not change the snapshot');
    console.log(JSON.stringify({ snapshotOnly: true, sourceUnchanged: true, payloads: rows.length,
        fullChainsValid: passed, previousBudgetValid: previousPassed, recoveredChains: previousPassed === null ? null : passed - previousPassed,
        configuredReplayBytes: config.maxReplayBytes, longestAncestry: longest, largestChainSerializedBytes: largest,
        elapsedMs: Math.round(performance.now() - started) }, null, 2));
} finally { db.close(); }
