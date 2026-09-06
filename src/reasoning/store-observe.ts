import type { DatabaseSync } from 'node:sqlite';
import { DAY_MS } from './retention.ts';
import type { Observation } from './types.ts';
import type { StoreFiles } from './store-files.ts';
import { outputHash, touchRecords } from './store-records.ts';
import type { IntentRow, RecordReader } from './store-records.ts';
import { putMarker } from './store-schema.ts';

export function publishObservation(
    db: DatabaseSync, files: StoreFiles, reader: RecordReader, intent: IntentRow, observation: Observation,
    now: number, maxEntryBytes: number, diskBytes: number,
): void {
    if (intent.phase !== 'dispatch') throw new Error('Replay intent already observed');
    const json = observation.output === null ? null : JSON.stringify(observation.output);
    const bytes = json === null ? 0 : Buffer.byteLength(json, 'utf8');
    const hash = json === null ? null : outputHash(json);
    const complete = !!observation.endDigest && !!observation.envelopeFingerprint && !!observation.payloadFingerprint;
    const oversized = bytes > maxEntryBytes;
    if (observation.snapshot) {
        db.prepare('UPDATE scopes SET snapshot = ? WHERE digest = ?').run(observation.snapshot, intent.scope);
        db.prepare(`INSERT INTO snapshots(scope, snapshot, seen_at) VALUES (?, ?, ?)
            ON CONFLICT(scope, snapshot) DO UPDATE SET seen_at = max(seen_at, excluded.seen_at)`)
            .run(intent.scope, observation.snapshot, now);
        db.prepare('DELETE FROM snapshots WHERE scope = ? AND snapshot <> ? AND seen_at < ?')
            .run(intent.scope, observation.snapshot, now - DAY_MS);
    }
    if (!complete || json === null || oversized) putMarker(db, intent.scope, 'start-poison', intent.start_digest, now);
    db.prepare("UPDATE intents SET phase = 'delivery', end_digest = ?, deadline = ? WHERE id = ?")
        .run(observation.endDigest, observation.deliveryDeadline, intent.id);
    if (!complete) return;
    const end = observation.endDigest!;
    const validation = reader.validation();
    // Even a conflicting repeated observation is a qualifying identity/ancestry touch.
    const oldRecord = validation.load(intent.scope, end);
    if (oldRecord && validation.validate(oldRecord, false)) touchRecords(db, validation.records(), now);
    const old = db.prepare(`SELECT start_digest <> ? OR payload_fingerprint <> ? OR envelope_fingerprint <> ?
        OR prior_plan <> ? OR (output_hash IS NOT NULL AND ? IS NOT NULL AND output_hash <> ?) conflict
        FROM observations WHERE scope = ? AND end_digest = ?`)
        .get(intent.start_digest, observation.payloadFingerprint!, observation.envelopeFingerprint!, intent.prior_plan,
            hash, hash, intent.scope, end);
    if (old?.conflict) {
        putMarker(db, intent.scope, 'end-conflict', end, now);
        db.prepare('UPDATE observations SET replayable = 0 WHERE scope = ? AND end_digest = ?').run(intent.scope, end);
        return;
    }
    const generation = db.prepare('SELECT generation FROM scopes WHERE digest = ?').get(intent.scope)?.generation;
    const plan = reader.parsePlan(intent.prior_plan);
    let validPlan = plan !== null;
    for (const [index, prior] of (plan ?? []).entries()) {
        const record = validation.load(intent.scope, prior.endDigest);
        if (!record || record.startDigest !== prior.startDigest || record.payloadFingerprint !== prior.payloadFingerprint
            || record.priorPlan.length !== index || record.priorPlan.some((entry, i) =>
                entry.startDigest !== plan![i]!.startDigest || entry.endDigest !== plan![i]!.endDigest
                || entry.payloadFingerprint !== plan![i]!.payloadFingerprint)
            || !validation.validate(record)) { validPlan = false; break; }
    }
    const marked = db.prepare(`SELECT 1 FROM markers WHERE scope = ? AND
        ((kind = 'start-poison' AND digest = ?) OR (kind = 'end-conflict' AND digest = ?)) LIMIT 1`)
        .get(intent.scope, intent.start_digest, end);
    const replayable = observation.admit && !!observation.snapshot && json !== null && !oversized && !marked && validPlan
        && generation === intent.generation && files.canAdmit(bytes, diskBytes);
    db.prepare(`INSERT INTO observations(scope, end_digest, start_digest, payload_fingerprint, output_hash,
        envelope_fingerprint, prior_plan, generation, producing_intent_id, snapshot, replayable, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope, end_digest) DO UPDATE SET generation = excluded.generation,
        producing_intent_id = excluded.producing_intent_id, snapshot = excluded.snapshot,
        replayable = excluded.replayable, output_hash = coalesce(observations.output_hash, excluded.output_hash)`)
        .run(intent.scope, end, intent.start_digest, observation.payloadFingerprint!, hash,
            observation.envelopeFingerprint!, intent.prior_plan, intent.generation, intent.id,
            observation.snapshot, replayable ? 1 : 0, now);
    if (!replayable) return;
    db.prepare(`INSERT INTO payloads(scope, end_digest, output_json, touched_at, bytes) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(scope, end_digest) DO UPDATE SET output_json = excluded.output_json,
        touched_at = max(payloads.touched_at, excluded.touched_at), bytes = excluded.bytes`)
        .run(intent.scope, end, json!, now, bytes);
    const ancestors = validation.records().filter((record) => record.endDigest !== end);
    for (const ancestor of ancestors) {
        db.prepare('INSERT OR IGNORE INTO dependencies(scope, child_end, ancestor_end) VALUES (?, ?, ?)')
            .run(intent.scope, end, ancestor.endDigest);
    }
    touchRecords(db, ancestors, now);
    db.prepare('INSERT OR IGNORE INTO intent_dependencies(intent_id, scope, end_digest) VALUES (?, ?, ?)')
        .run(intent.id, intent.scope, end);
}
