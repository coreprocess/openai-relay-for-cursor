import { lstatSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

export const INSPECTION_ROW_LIMIT = 10_000;
export const INSPECTION_TTL_MS = 5_000;
export type BoundedCount = Readonly<{ value: number; accuracy: 'exact' | 'lower-bound' }>;
const tables = ['scopes', 'observations', 'payloads', 'markers', 'intents', 'snapshots',
    'dependencies', 'intent_dependencies', 'metadata'] as const;
export type InspectionTable = typeof tables[number];
export type PhysicalFile = Readonly<{ bytes: number; allocatedBytes: number }>;
export type PhysicalSizes = Readonly<{
    database: PhysicalFile | null; wal: PhysicalFile | null; shm: PhysicalFile | null; reserve: PhysicalFile | null;
}>;
export type InspectionMetrics = Readonly<{
    sampledAt: number;
    rowLimit: number;
    counts: Readonly<Record<InspectionTable, BoundedCount>>;
    intentsByPhase: Readonly<Record<'dispatch' | 'delivery', BoundedCount>>;
    payloadSerializedBytes: Readonly<{
        value: number; accuracy: 'exact' | 'lower-bound'; sampledRows: number;
        basis: 'bounded-stored-serialized-bytes';
    }>;
    physical: PhysicalSizes;
}>;

function physicalFile(path: string): PhysicalFile | null {
    try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) return null;
        return Object.freeze({ bytes: stat.size, allocatedBytes: stat.blocks * 512 });
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? Object.freeze({ bytes: 0, allocatedBytes: 0 }) : null;
    }
}

export function physicalSizes(path: string): PhysicalSizes {
    return Object.freeze({ database: physicalFile(path), wal: physicalFile(`${path}-wal`),
        shm: physicalFile(`${path}-shm`), reserve: physicalFile(`${path}.reserve`) });
}

const bounded = (value: number, truncated: boolean): BoundedCount => Object.freeze({
    value, accuracy: truncated ? 'lower-bound' : 'exact',
});

/** Only constant table names and numerical aggregates leave SQLite. No record material is loaded. */
export function collectInspectionMetrics(db: DatabaseSync, path: string, sampledAt: number): InspectionMetrics {
    const counts = {} as Record<InspectionTable, BoundedCount>;
    for (const table of tables) {
        if (table === 'intents' || table === 'payloads') continue;
        const value = Number(db.prepare(`SELECT count(*) AS value FROM (SELECT 1 FROM ${table} LIMIT ?)`)
            .get(INSPECTION_ROW_LIMIT + 1)!.value);
        counts[table] = bounded(value, value > INSPECTION_ROW_LIMIT);
    }
    const phases = db.prepare(`SELECT count(*) AS total, coalesce(sum(phase = 'dispatch'), 0) AS dispatch,
        coalesce(sum(phase = 'delivery'), 0) AS delivery FROM (SELECT phase FROM intents LIMIT ?)`)
        .get(INSPECTION_ROW_LIMIT + 1)!;
    counts.intents = bounded(Number(phases.total), Number(phases.total) > INSPECTION_ROW_LIMIT);
    const intentsByPhase = { dispatch: bounded(Number(phases.dispatch), counts.intents.accuracy !== 'exact'),
        delivery: bounded(Number(phases.delivery), counts.intents.accuracy !== 'exact') };
    const payload = db.prepare(`SELECT coalesce(sum(bytes), 0) AS value, count(*) AS rows FROM
        (SELECT bytes FROM payloads LIMIT ?)`).get(INSPECTION_ROW_LIMIT + 1)!;
    counts.payloads = bounded(Number(payload.rows), Number(payload.rows) > INSPECTION_ROW_LIMIT);
    return Object.freeze({ sampledAt, rowLimit: INSPECTION_ROW_LIMIT, counts: Object.freeze(counts),
        intentsByPhase: Object.freeze(intentsByPhase), physical: physicalSizes(path),
        payloadSerializedBytes: Object.freeze({ value: Number(payload.value), sampledRows: Number(payload.rows),
            accuracy: counts.payloads.accuracy, basis: 'bounded-stored-serialized-bytes' as const }) });
}
