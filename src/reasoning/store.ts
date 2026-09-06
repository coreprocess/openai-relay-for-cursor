import { randomUUID } from 'node:crypto';
import { existsSync, chmodSync, constants, closeSync, openSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ReplayInspectionHelper } from './inspection.ts';
import type { InspectionOptions, InspectionSnapshot, ReplayInspection } from './inspection.ts';
import { INSPECTION_TTL_MS } from './inspection-metrics.ts';
import { CLEANUP_BATCH_SIZE, DAY_MS, RetentionClock } from './retention.ts';
import { existingReplayStore, loadSecret, StoreFiles } from './store-files.ts';
import { publishObservation } from './store-observe.ts';
import { planJson, RecordReader, touchRecords } from './store-records.ts';
import type { IntentRow } from './store-records.ts';
import { initializeSchema, putMarker, recoverIntents } from './store-schema.ts';
import type { Observation, ReplayRecord, ScopeIdentity, StoreOptions } from './types.ts';

export class ReplayStore {
    readonly secret: string;
    private readonly options: StoreOptions;
    private readonly db: DatabaseSync;
    private readonly files: StoreFiles;
    private readonly clock: RetentionClock;
    private readonly reader: RecordReader;
    private readonly inspection: ReplayInspectionHelper;
    private closed = false;
    private failed = false;
    private coverageGap = false;

    constructor(options: StoreOptions, inspectionOptions: InspectionOptions = {}) {
        for (const name of ['diskBytes', 'reserveBytes', 'memoryBytes', 'maxEntryBytes'] as const) {
            if (!Number.isSafeInteger(options[name]) || options[name] < 0) throw new Error(`Invalid replay ${name}`);
        }
        for (const name of ['maxReplayBytes', 'maxPlanRecords'] as const) {
            if (options[name] !== undefined && (!Number.isSafeInteger(options[name]) || options[name]! < 0)) {
                throw new Error(`Invalid replay ${name}`);
            }
        }
        this.options = { ...options, path: resolve(options.path) };
        this.clock = new RetentionClock(options.idleDays, options.wallNow, options.monotonicNow);
        if (existsSync(`${this.options.path}.blocked`)) throw new Error('Replay store requires manual recovery after a failed safety write');
        this.secret = loadSecret(this.options.path);
        if (!existsSync(this.options.path)) {
            const fd = openSync(this.options.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
            closeSync(fd);
        }
        chmodSync(this.options.path, 0o600);
        this.files = new StoreFiles(this.options.path, options.reserveBytes);
        this.db = new DatabaseSync(this.options.path);
        this.reader = new RecordReader(this.db, this.options);
        this.inspection = new ReplayInspectionHelper(this.db, this.options.path, inspectionOptions);
        try {
            this.db.exec(`PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE;
                PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;
                PRAGMA wal_autocheckpoint = 256;`);
            // The immediate startup write acquires the lifetime exclusive lock, even on an empty database.
            this.transaction(() => {
                this.files.openReserve();
                initializeSchema(this.db);
                const now = this.clock.now();
                recoverIntents(this.db, now);
                if (this.db.prepare("SELECT value FROM metadata WHERE key = 'coverage-gap'").get()?.value === '1') {
                    this.db.exec('UPDATE scopes SET generation = generation + 1');
                    this.db.prepare("DELETE FROM metadata WHERE key = 'coverage-gap'").run();
                }
                this.db.prepare("INSERT INTO metadata(key, value) VALUES ('last-opened', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
                    .run(String(now));
            });
            this.files.allocateReserve();
        } catch (error) {
            this.db.close();
            this.files.close();
            throw error;
        }
    }

    private assertOpen(): void {
        if (this.closed || this.failed) throw new Error('Replay store is closed or failed');
    }

    private assertEnabled(): void {
        this.assertOpen();
        if (this.coverageGap) throw new Error('Replay coverage is disabled until the store is reopened');
    }

    private transaction<T>(operation: () => T): T {
        this.assertOpen();
        for (let attempt = 0; ; attempt++) {
            try {
                this.db.exec('BEGIN IMMEDIATE');
                const result = operation();
                this.db.exec('COMMIT');
                return result;
            } catch (error) {
                this.reader.clear();
                try { if (this.db.isTransaction) this.db.exec('ROLLBACK'); }
                catch (rollbackError) { this.failClosed(rollbackError); }
                const code = (error as { errcode?: number }).errcode;
                const errno = (error as NodeJS.ErrnoException).code;
                const capacityFailure = (code !== undefined && [10, 13].includes(code & 0xff))
                    || errno === 'ENOSPC' || errno === 'EDQUOT' || errno === 'EIO';
                if (!capacityFailure) throw error;
                if (attempt === 0) {
                    try { if (this.files.releaseReserve()) continue; }
                    catch (reserveError) { this.failClosed(reserveError); }
                }
                this.failClosed(error);
            }
        }
    }

    private failClosed(cause: unknown): never {
        this.failed = true;
        try { this.files.blockReopening(); } catch { /* Hardware failure can prevent all durable writes; traffic still stops. */ }
        throw new Error('Replay safety metadata could not be committed; traffic must stop', { cause });
    }

    private ensureScopeInTransaction(scope: ScopeIdentity): number {
        const row = this.db.prepare('SELECT * FROM scopes WHERE digest = ?').get(scope.digest);
        if (row) {
            if (row.credential !== scope.credential || row.model !== scope.model || row.caller !== scope.caller) {
                throw new Error('Replay scope identity mismatch');
            }
            return Number(row.generation);
        }
        this.db.prepare('INSERT INTO scopes(digest, credential, model, caller) VALUES (?, ?, ?, ?)')
            .run(scope.digest, scope.credential, scope.model, scope.caller);
        return 1;
    }

    ensureScope(scope: ScopeIdentity): number {
        this.assertEnabled();
        return this.transaction(() => this.ensureScopeInTransaction(scope));
    }

    get(scope: string, end: string): ReplayRecord | null {
        this.assertEnabled();
        return this.reader.validation().load(scope, end);
    }

    canReplay(record: ReplayRecord): boolean {
        this.assertEnabled();
        return this.reader.validation().validate(record);
    }

    touchVerified(record: ReplayRecord): boolean {
        this.assertEnabled();
        return this.transaction(() => {
            const validation = this.reader.validation();
            if (!validation.validate(record, false)) return false;
            touchRecords(this.db, validation.records(), this.clock.now());
            return true;
        });
    }

    snapshotAccepted(scope: string, snapshot: string): boolean {
        this.assertEnabled();
        const last = this.db.prepare('SELECT snapshot FROM scopes WHERE digest = ?').get(scope)?.snapshot;
        if (!last || last === snapshot) return true;
        return !!this.db.prepare('SELECT 1 FROM snapshots WHERE scope = ? AND snapshot = ? AND seen_at >= ?')
            .get(scope, snapshot, this.clock.now() - DAY_MS);
    }

    begin(scope: ScopeIdentity, startDigest: string, plan: ReplayRecord[], deadline: number): string {
        this.assertEnabled();
        if (!Number.isFinite(deadline) || !startDigest) throw new Error('Invalid replay intent');
        this.files.assertDispatchCapacity();
        return this.transaction(() => {
            const now = this.clock.now();
            const generation = this.ensureScopeInTransaction(scope);
            if (plan.length > this.reader.maxRecords || Buffer.byteLength(planJson(plan)) > this.reader.maxPlanBytes) {
                throw new Error('Replay plan exceeds validation budget');
            }
            const dictating = plan.at(-1);
            if (dictating && !this.snapshotAccepted(scope.digest, dictating.snapshot)) throw new Error('Replay dictating snapshot is no longer accepted');
            const validation = this.reader.validation();
            for (const [index, record] of plan.entries()) {
                if (record.scope !== scope.digest) throw new Error('Replay plan scope mismatch');
                if (!validation.validate(record)) throw new Error('Replay plan is no longer safe; dispatch must be replanned');
                if (planJson(record.priorPlan) !== planJson(plan.slice(0, index))) throw new Error('Replay plan provenance mismatch');
            }
            const id = randomUUID();
            this.db.prepare(`INSERT INTO intents(id, scope, generation, start_digest, prior_plan, deadline, phase)
                VALUES (?, ?, ?, ?, ?, ?, 'dispatch')`).run(id, scope.digest, generation, startDigest, planJson(plan), deadline);
            touchRecords(this.db, validation.records(), now, id);
            return id;
        });
    }

    /** Cache pressure must not reject model work or leave an unobserved competing generation.
     * Permanently cover every possible output at this position BEFORE forwarding without capture. */
    bypass(scope: ScopeIdentity, startDigest: string): void {
        this.assertEnabled();
        if (!startDigest) throw new Error('Invalid replay bypass position');
        this.transaction(() => {
            this.ensureScopeInTransaction(scope);
            putMarker(this.db, scope.digest, 'start-poison', startDigest, this.clock.now());
        });
    }

    renew(id: string, deadline: number): void {
        this.assertEnabled();
        if (!Number.isFinite(deadline)) throw new Error('Invalid replay deadline');
        this.transaction(() => {
            const result = this.db.prepare('UPDATE intents SET deadline = max(deadline, ?) WHERE id = ?').run(deadline, id);
            if (!result.changes) throw new Error('Unknown replay intent');
        });
    }

    observe(id: string, observation: Observation): void {
        this.assertEnabled();
        if (!Number.isFinite(observation.deliveryDeadline)) throw new Error('Invalid delivery deadline');
        this.transaction(() => {
            const metadata = this.db.prepare('SELECT octet_length(prior_plan) plan_bytes FROM intents WHERE id = ?').get(id);
            if (!metadata) throw new Error('Unknown replay intent');
            if (Number(metadata.plan_bytes) > this.reader.maxPlanBytes) throw new Error('Replay intent provenance exceeds validation budget');
            const intent = this.db.prepare('SELECT * FROM intents WHERE id = ?').get(id) as IntentRow;
            publishObservation(this.db, this.files, this.reader, intent, observation, this.clock.now(), this.options.maxEntryBytes, this.options.diskBytes);
        });
    }

    /** A validation rejection invalidates only blocks actually dispatched in this intent. */
    rejectReplay(id: string): void {
        this.assertEnabled();
        this.transaction(() => {
            const metadata = this.db.prepare('SELECT scope, octet_length(prior_plan) size FROM intents WHERE id = ?').get(id);
            if (!metadata) return;
            if (Number(metadata.size) > this.reader.maxPlanBytes) throw new Error('Invalid replay rejection provenance');
            const row = this.db.prepare('SELECT prior_plan FROM intents WHERE id = ?').get(id)!;
            const plan = this.reader.parsePlan(String(row.prior_plan));
            if (!plan) throw new Error('Invalid replay rejection provenance');
            for (const record of plan) {
                putMarker(this.db, String(metadata.scope), 'end-conflict', record.endDigest, this.clock.now());
                this.db.prepare('UPDATE observations SET replayable = 0 WHERE scope = ? AND end_digest = ?')
                    .run(metadata.scope!, record.endDigest);
            }
        });
    }

    resolve(id: string): void {
        this.assertEnabled();
        this.transaction(() => { this.db.prepare('DELETE FROM intents WHERE id = ?').run(id); });
    }

    poison(id: string): void {
        this.assertEnabled();
        this.transaction(() => {
            const intent = this.db.prepare('SELECT * FROM intents WHERE id = ?').get(id) as IntentRow | undefined;
            if (!intent) return;
            putMarker(this.db, intent.scope, 'start-poison', intent.start_digest, this.clock.now());
            this.db.prepare('DELETE FROM intents WHERE id = ?').run(id);
        });
    }

    fence(credential: string, model: string, caller?: string): void {
        this.assertEnabled();
        this.transaction(() => {
            const callerPredicate = caller === undefined ? '' : ' AND caller = ?';
            const args = caller === undefined ? [credential, model] : [credential, model, caller];
            this.db.prepare(`INSERT OR IGNORE INTO markers(scope, kind, digest, created_at)
                SELECT i.scope, 'start-poison', i.start_digest, ? FROM intents i JOIN scopes s ON s.digest = i.scope
                WHERE credential = ? AND model = ?${callerPredicate}`).run(this.clock.now(), ...args);
            this.db.prepare(`UPDATE scopes SET generation = generation + 1 WHERE credential = ? AND model = ?${callerPredicate}`).run(...args);
        });
    }

    expire(now = this.clock.now()): void {
        this.assertEnabled();
        if (!Number.isFinite(now)) throw new Error('Invalid replay expiry time');
        this.transaction(() => recoverIntents(this.db, this.clock.now(), now));
    }

    cleanup(): number {
        this.assertEnabled();
        const cutoff = this.clock.deletionCutoff();
        if (cutoff === null) return 0;
        return this.transaction(() => {
            const candidates = this.db.prepare(`SELECT p.scope, p.end_digest FROM payloads p
                WHERE p.touched_at <= ? AND NOT EXISTS (
                    SELECT 1 FROM intent_dependencies i WHERE i.scope = p.scope AND i.end_digest = p.end_digest
                ) AND NOT EXISTS (
                    SELECT 1 FROM intents i JOIN observations o ON o.scope = i.scope AND o.start_digest = i.start_digest
                    WHERE o.scope = p.scope AND o.end_digest = p.end_digest
                ) AND NOT EXISTS (
                    SELECT 1 FROM dependencies d WHERE d.scope = p.scope AND d.ancestor_end = p.end_digest
                ) LIMIT ?`);
            const remove = this.db.prepare('DELETE FROM payloads WHERE scope = ? AND end_digest = ?');
            let deleted = 0;
            while (deleted < CLEANUP_BATCH_SIZE) {
                const leaves = candidates.all(cutoff, CLEANUP_BATCH_SIZE - deleted);
                if (!leaves.length) break;
                for (const row of leaves) remove.run(row.scope!, row.end_digest!);
                deleted += leaves.length;
            }
            return deleted;
        });
    }

    markCoverageGap(): void {
        this.assertOpen();
        this.transaction(() => {
            this.db.prepare("INSERT INTO metadata(key, value) VALUES ('coverage-gap', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
        });
        this.coverageGap = true;
    }

    /** Metadata only: no replay validation, clock sampling, touches, expiry, or cleanup. */
    inspect(): ReplayInspection {
        const enabled = !this.closed && !this.failed && !this.coverageGap;
        return Object.freeze({ state: this.closed ? 'closed' : this.failed ? 'failed' : this.coverageGap ? 'disabled' : 'ready',
            enabled, closed: this.closed, failed: this.failed, coverageGap: this.coverageGap,
            retention: this.clock.status(), cacheTtlMs: INSPECTION_TTL_MS, snapshotPending: this.inspection.isPending,
            ...this.inspection.inspect(!this.closed && !this.failed && !this.db.isTransaction) });
    }

    async createInspectionSnapshot(): Promise<InspectionSnapshot> {
        this.assertOpen();
        if (this.db.isTransaction) throw new Error('Inspection snapshot refuses an active database transaction');
        return this.inspection.createSnapshot(() => {
            this.assertOpen();
            if (this.db.isTransaction) throw new Error('Inspection snapshot refuses an active database transaction');
        });
    }

    /** Shutdown waits even if the snapshot request failed; that request receives its own error. */
    waitForInspection(): Promise<void> { return this.inspection.wait(); }

    close(): void {
        if (this.closed) return;
        if (this.inspection.isPending) throw new Error('Replay inspection pending; await waitForInspection() before close()');
        this.closed = true;
        this.reader.clear();
        try { this.db.close(); } finally { this.files.close(); }
    }

    static markCoverageGapIfExists(options: StoreOptions): boolean {
        if (!existingReplayStore(options.path)) return false;
        const store = new ReplayStore(options);
        try { store.markCoverageGap(); } finally { store.close(); }
        return true;
    }
}

export const markCoverageGapIfExists = (options: StoreOptions): boolean => ReplayStore.markCoverageGapIfExists(options);
