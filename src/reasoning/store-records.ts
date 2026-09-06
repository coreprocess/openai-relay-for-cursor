import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { SizedHotCache } from './resources.ts';
import type { ReplayDescriptor, ReplayRecord, StoreOptions } from './types.ts';

export type ObservationRow = {
    scope: string; end_digest: string; start_digest: string; payload_fingerprint: string;
    output_hash: string | null; envelope_fingerprint: string; prior_plan: string; generation: number;
    producing_intent_id: string; snapshot: string; replayable: number; created_at: number;
};
type PayloadRow = ObservationRow & { output_json: string; touched_at: number; bytes: number };
export type IntentRow = {
    id: string; scope: string; generation: number; start_digest: string; prior_plan: string;
    deadline: number; end_digest: string | null; phase: 'dispatch' | 'delivery';
};
type Metadata = {
    output_bytes: number; plan_bytes: number; metadata_bytes: number; bytes: number;
    observation_version: number; payload_version: number;
};
type CachedRecord = { version: string; record: ReplayRecord };
const EXPANSION = 32;
const keyFor = (scope: string, end: string): string => JSON.stringify([scope, end]);
export const outputHash = (json: string): string => createHash('sha256').update(json).digest('hex');
export const descriptor = (record: ReplayDescriptor): ReplayDescriptor => ({
    startDigest: record.startDigest, endDigest: record.endDigest, payloadFingerprint: record.payloadFingerprint,
});
export const planJson = (plan: ReplayDescriptor[]): string => JSON.stringify(plan.map(descriptor));
const matches = (a: ReplayDescriptor, b: ReplayDescriptor): boolean => a.startDigest === b.startDigest
    && a.endDigest === b.endDigest && a.payloadFingerprint === b.payloadFingerprint;

function freezeJson<T>(value: T): T {
    const stack: unknown[] = [value];
    while (stack.length) {
        const item = stack.pop();
        if (!item || typeof item !== 'object' || Object.isFrozen(item)) continue;
        Object.freeze(item);
        for (const child of Object.values(item)) if (child && typeof child === 'object') stack.push(child);
    }
    return value;
}

/** Traverse only the bounded authoritative shape; do not stringify an untrusted caller's record. */
function equalJson(value: unknown, authority: unknown): boolean {
    const stack: [unknown, unknown][] = [[value, authority]];
    while (stack.length) {
        const [left, right] = stack.pop()!;
        if (left === right) continue;
        if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
        if (Array.isArray(left) !== Array.isArray(right)) return false;
        if (Array.isArray(left) && left.length !== (right as unknown[]).length) return false;
        const keys = Object.keys(right);
        let index = 0;
        for (const key in left) {
            if (!Object.hasOwn(left, key)) continue;
            if (key !== keys[index++]) return false;
            const property = Object.getOwnPropertyDescriptor(left, key);
            if (!property || !('value' in property)) return false;
            stack.push([property.value, (right as Record<string, unknown>)[key]]);
        }
        if (index !== keys.length) return false;
    }
    return true;
}

export function sameRecord(left: ReplayRecord, right: ReplayRecord): boolean {
    return left === right || (left.scope === right.scope && left.generation === right.generation
        && matches(left, right) && left.envelopeFingerprint === right.envelopeFingerprint
        && left.producingIntentId === right.producingIntentId && left.snapshot === right.snapshot
        && left.createdAt === right.createdAt && left.bytes === right.bytes
        && equalJson(left.priorPlan, right.priorPlan) && equalJson(left.output, right.output));
}

export class RecordReader {
    readonly maxRecords: number;
    readonly maxBytes: number;
    readonly maxPlanBytes: number;
    readonly maxEntryBytes: number;
    private readonly hot: SizedHotCache<CachedRecord>;
    readonly db: DatabaseSync;

    constructor(db: DatabaseSync, options: StoreOptions) {
        this.db = db;
        this.maxRecords = options.maxPlanRecords ?? 256;
        this.maxBytes = options.maxReplayBytes ?? 16 * 1024 * 1024;
        this.maxEntryBytes = options.maxEntryBytes;
        this.maxPlanBytes = Math.min(this.maxBytes, this.maxRecords * 1024);
        this.hot = new SizedHotCache(options.memoryBytes);
    }

    clear(): void { this.hot.clear(); }
    validation(): RecordValidation { return new RecordValidation(this); }

    read(scope: string, end: string, charge: (bytes: number, payloadBytes: number) => boolean): ReplayRecord | null {
        // SQLite returns only scalar lengths/versions before any possibly corrupt JSON crosses into JS.
        const metadata = this.db.prepare(`SELECT p.bytes, octet_length(p.output_json) output_bytes,
            octet_length(o.prior_plan) plan_bytes, o.row_version observation_version, p.row_version payload_version,
            octet_length(o.scope) + octet_length(o.end_digest) + octet_length(o.start_digest)
            + octet_length(o.payload_fingerprint) + coalesce(octet_length(o.output_hash), 0)
            + octet_length(o.envelope_fingerprint) + octet_length(o.producing_intent_id) + octet_length(o.snapshot) metadata_bytes
            FROM observations o JOIN payloads p USING(scope, end_digest) WHERE o.scope = ? AND o.end_digest = ?`)
            .get(scope, end) as Metadata | undefined;
        if (!metadata || metadata.output_bytes > this.maxEntryBytes || metadata.output_bytes !== metadata.bytes
            || metadata.plan_bytes > this.maxPlanBytes || metadata.metadata_bytes > 8192) return null;
        const bytes = (metadata.output_bytes + metadata.plan_bytes + metadata.metadata_bytes) * EXPANSION + 1024;
        if (!charge(bytes, metadata.output_bytes)) return null;
        const key = keyFor(scope, end);
        const version = `${metadata.observation_version}:${metadata.payload_version}`;
        const cached = this.hot.get(key);
        if (cached?.version === version) return cached.record;
        const row = this.db.prepare(`SELECT o.*, p.output_json, p.touched_at, p.bytes FROM observations o
            JOIN payloads p USING(scope, end_digest) WHERE o.scope = ? AND o.end_digest = ?`).get(scope, end) as PayloadRow;
        const priorPlan = this.parsePlan(row.prior_plan);
        if (!priorPlan || row.output_hash !== outputHash(row.output_json)) return null;
        let output: unknown;
        try { output = JSON.parse(row.output_json); } catch { return null; }
        if (!Array.isArray(output) || !output.every((item) => item && typeof item === 'object' && !Array.isArray(item))) return null;
        const record: ReplayRecord = freezeJson({
            scope: row.scope, startDigest: row.start_digest, endDigest: row.end_digest,
            payloadFingerprint: row.payload_fingerprint, envelopeFingerprint: row.envelope_fingerprint,
            output, priorPlan, generation: row.generation, producingIntentId: row.producing_intent_id,
            snapshot: row.snapshot, createdAt: row.created_at, touchedAt: row.touched_at, bytes: row.bytes,
        });
        this.hot.set(key, { version, record }, bytes);
        return record;
    }

    parsePlan(json: string): ReplayDescriptor[] | null {
        if (Buffer.byteLength(json) > this.maxPlanBytes) return null;
        // SQLite counts items before JSON.parse can allocate a descriptor array.
        let count: number;
        try {
            const row = this.db.prepare("SELECT CASE WHEN json_type(?) = 'array' THEN json_array_length(?) ELSE -1 END count")
                .get(json, json)!;
            count = Number(row.count);
        } catch { return null; }
        if (count < 0 || count > this.maxRecords) return null;
        const plan = JSON.parse(json) as ReplayDescriptor[];
        if (!plan.every((item) => item && typeof item === 'object' && Object.keys(item).length === 3
            && typeof item.startDigest === 'string' && typeof item.endDigest === 'string'
            && typeof item.payloadFingerprint === 'string')) return null;
        return plan;
    }
}

/** One budget, one read/hash/parse per identity, shared by all roots within an operation. */
export class RecordValidation {
    private readonly loaded = new Map<string, ReplayRecord | null>();
    private readonly expanded = new Set<string>();
    private readonly replayExpanded = new Set<string>();
    private readonly verified = new Map<string, ReplayRecord>();
    private bytes = 0;
    private payloadBytes = 0;
    private invalid = false;
    private readonly reader: RecordReader;
    constructor(reader: RecordReader) { this.reader = reader; }

    load(scope: string, end: string): ReplayRecord | null {
        const key = keyFor(scope, end);
        if (this.loaded.has(key)) return this.loaded.get(key)!;
        if (this.loaded.size >= this.reader.maxRecords) return null;
        const record = this.reader.read(scope, end, (bytes, payloadBytes) => {
            if (this.bytes + bytes > this.reader.maxBytes * EXPANSION
                || this.payloadBytes + payloadBytes > this.reader.maxBytes) return false;
            this.bytes += bytes;
            this.payloadBytes += payloadBytes;
            return true;
        });
        this.loaded.set(key, record);
        return record;
    }

    validate(record: ReplayRecord, replay = true): boolean {
        if (this.invalid) return false;
        const valid = this.walk(record, replay);
        if (!valid) this.invalid = true;
        return valid;
    }

    private walk(record: ReplayRecord, replay: boolean): boolean {
        const current = this.load(record.scope, record.endDigest);
        if (!current || !sameRecord(record, current)) return false;
        const expanded = replay ? this.replayExpanded : this.expanded;
        const lineage = [...current.priorPlan, descriptor(current)];
        const positions = new Map(lineage.map((item, index) => [item.endDigest, index]));
        if (positions.size !== lineage.length) return false;
        const queue = [current];
        const scheduled = new Set([keyFor(current.scope, current.endDigest)]);
        while (queue.length) {
            const candidate = queue.pop()!;
            const key = keyFor(candidate.scope, candidate.endDigest);
            if (expanded.has(key)) continue;
            const position = positions.get(candidate.endDigest);
            if (position === undefined || candidate.priorPlan.length !== position
                || candidate.priorPlan.some((prior, index) => !matches(prior, lineage[index]!))) return false;
            if (replay && !this.safe(candidate)) return false;
            expanded.add(key);
            this.verified.set(key, candidate);
            for (const [index, prior] of candidate.priorPlan.entries()) {
                if (prior.endDigest === candidate.endDigest) return false;
                const ancestorKey = keyFor(candidate.scope, prior.endDigest);
                // load() deduplicates before querying or parsing; scheduled deduplicates the work queue.
                const ancestor = this.load(candidate.scope, prior.endDigest);
                if (!ancestor || !matches(ancestor, prior) || ancestor.generation !== candidate.generation
                    || ancestor.priorPlan.length !== index) return false;
                if (scheduled.has(ancestorKey) || expanded.has(ancestorKey)) continue;
                scheduled.add(ancestorKey);
                queue.push(ancestor);
            }
        }
        return true;
    }

    records(): ReplayRecord[] { return [...this.verified.values()]; }

    private safe(record: ReplayRecord): boolean {
        const row = this.reader.db.prepare(`SELECT o.replayable, s.generation,
            EXISTS(SELECT 1 FROM markers WHERE scope = o.scope AND
                ((kind = 'start-poison' AND digest = o.start_digest) OR (kind = 'end-conflict' AND digest = o.end_digest))) blocked,
            EXISTS(SELECT 1 FROM intents WHERE scope = o.scope AND start_digest = o.start_digest AND id <> o.producing_intent_id) competing
            FROM observations o JOIN scopes s ON s.digest = o.scope WHERE o.scope = ? AND o.end_digest = ?`)
            .get(record.scope, record.endDigest);
        return !!row && row.replayable === 1 && row.generation === record.generation && !row.blocked && !row.competing;
    }
}

export function touchRecords(db: DatabaseSync, records: ReplayRecord[], now: number, intentId?: string): void {
    const touch = db.prepare('UPDATE payloads SET touched_at = max(touched_at, ?) WHERE scope = ? AND end_digest = ?');
    const dependency = db.prepare('INSERT OR IGNORE INTO intent_dependencies(intent_id, scope, end_digest) VALUES (?, ?, ?)');
    for (const record of records) {
        touch.run(now, record.scope, record.endDigest);
        if (intentId) dependency.run(intentId, record.scope, record.endDigest);
    }
}
