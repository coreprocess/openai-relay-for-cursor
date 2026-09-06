import { closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { backup } from 'node:sqlite';
import type { DatabaseSync } from 'node:sqlite';
import { availableInspectionBytes, createInspectionDestination, removeInspectionDirectory,
    syncInspectionDirectory } from './inspection-files.ts';
import { collectInspectionMetrics, INSPECTION_TTL_MS, physicalSizes } from './inspection-metrics.ts';
import type { InspectionMetrics } from './inspection-metrics.ts';
import type { RetentionStatus } from './retention.ts';

export const INSPECTION_MIN_FREE_BYTES = 64 * 1024 * 1024;
export const INSPECTION_MAX_SOURCE_BYTES = 256 * 1024 * 1024;
export const INSPECTION_BACKUP_PAGES = 32;
export type InspectionOptions = {
    directory?: string;
    backup?: typeof backup;
    availableBytes?: (directory: string) => number;
    monotonicNow?: () => number;
    wallNow?: () => number;
    maxSourceBytes?: number;
};
export type InspectionSnapshot = Readonly<{
    path: string; bytes: number; pages: number; createdAt: number; inspectionOnly: true;
}>;
export type ReplayInspection = Readonly<{
    state: 'ready' | 'disabled' | 'failed' | 'closed';
    enabled: boolean; failed: boolean; closed: boolean; coverageGap: boolean;
    retention: RetentionStatus;
    metrics: InspectionMetrics | null;
    metricsAvailable: boolean;
    cacheTtlMs: number;
    snapshotPending: boolean;
}>;

/** Holds only inspection state; failures never enter ReplayStore's fail-closed path. */
export class ReplayInspectionHelper {
    private readonly db: DatabaseSync;
    private readonly path: string;
    private readonly options: InspectionOptions;
    private metrics: InspectionMetrics | null = null;
    private nextRefresh = -Infinity;
    private pending: Promise<InspectionSnapshot> | undefined;

    constructor(db: DatabaseSync, path: string, options: InspectionOptions = {}) {
        this.db = db;
        this.path = path;
        this.options = { ...options };
    }

    get isPending(): boolean { return this.pending !== undefined; }

    inspect(canRead: boolean): { metrics: InspectionMetrics | null; metricsAvailable: boolean } {
        const now = (this.options.monotonicNow ?? (() => performance.now()))();
        if (canRead && now >= this.nextRefresh) {
            this.nextRefresh = now + INSPECTION_TTL_MS;
            try { this.metrics = collectInspectionMetrics(this.db, this.path, (this.options.wallNow ?? Date.now)()); }
            catch { this.metrics = null; }
        }
        return { metrics: this.metrics, metricsAvailable: canRead && this.metrics !== null };
    }

    async wait(): Promise<void> {
        try { await this.pending; } catch { /* The snapshot caller owns its error; shutdown must still proceed. */ }
    }

    createSnapshot(assertReady: () => void): Promise<InspectionSnapshot> {
        if (this.pending) return Promise.reject(new Error('Replay inspection snapshot already in progress'));
        // Defer all work until the single pending promise is published, including injected callbacks.
        const pending = Promise.resolve().then(() => {
            assertReady();
            return this.backupSnapshot(assertReady);
        }).finally(() => { this.pending = undefined; });
        this.pending = pending;
        return pending;
    }

    private assertCapacity(pageBytes: number, copiedBytes = 0): void {
        const maximum = this.options.maxSourceBytes ?? INSPECTION_MAX_SOURCE_BYTES;
        if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error('Invalid inspection source size limit');
        const { database, wal, shm } = physicalSizes(this.path);
        if (!database || !wal || !shm) throw new Error('Inspection source sizes unavailable');
        const physical = [database, wal, shm].reduce((sum, file) => sum + Math.max(file.bytes, file.allocatedBytes), 0);
        if (Math.max(physical, pageBytes) > maximum) throw new Error('Inspection source exceeds snapshot size limit');
        const free = (this.options.availableBytes ?? availableInspectionBytes)(this.options.directory ?? join(dirname(this.path), 'inspection'));
        if (!Number.isFinite(free) || free < Math.max(0, pageBytes - copiedBytes) + INSPECTION_MIN_FREE_BYTES) {
            throw new Error('Insufficient free space for inspection snapshot');
        }
    }

    private async backupSnapshot(assertReady: () => void): Promise<InspectionSnapshot> {
        if (!this.db.isOpen || this.db.isTransaction) throw new Error('Inspection requires an open database without an active transaction');
        const pageSize = Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
        const pageCount = Number(this.db.prepare('PRAGMA page_count').get()!.page_count);
        this.assertCapacity(pageSize * pageCount);
        const destination = createInspectionDestination(this.path, this.options.directory);
        let complete = false;
        try {
            const pages = await (this.options.backup ?? backup)(this.db, destination.temporaryPath, {
                rate: INSPECTION_BACKUP_PAGES,
                progress: ({ totalPages, remainingPages }) => {
                    assertReady();
                    this.assertCapacity(totalPages * pageSize, (totalPages - remainingPages) * pageSize);
                },
            });
            assertReady();
            this.assertCapacity(pages * pageSize, pages * pageSize);
            const stat = fstatSync(destination.fd);
            const named = lstatSync(destination.temporaryPath);
            if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.ino !== destination.identity.ino
                || named.dev !== destination.identity.dev || stat.size !== pages * pageSize) {
                throw new Error('Inspection snapshot file changed unexpectedly');
            }
            fchmodSync(destination.fd, 0o400);
            fsyncSync(destination.fd);
            renameSync(destination.temporaryPath, destination.path);
            syncInspectionDirectory(destination.directory);
            const result = Object.freeze({ path: destination.path, bytes: stat.size, pages,
                createdAt: (this.options.wallNow ?? Date.now)(), inspectionOnly: true as const });
            complete = true;
            return result;
        } finally {
            closeSync(destination.fd);
            if (!complete) removeInspectionDirectory(destination.directory);
        }
    }
}
