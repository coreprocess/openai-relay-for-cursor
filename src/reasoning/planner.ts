import { chatMessagesToInput } from '../chatMessages.ts';
import type { JsonBody } from '../http.ts';
import type { ReplayPlanningStore, ReplayStore } from './store.ts';
import type { PreparedIdentity, ReplayRecord } from './types.ts';

const descriptorMatches = (a: ReplayRecord, b: ReplayRecord['priorPlan'][number]): boolean =>
    a.startDigest === b.startDigest && a.endDigest === b.endDigest && a.payloadFingerprint === b.payloadFingerprint;

export const selectReplayPlan = (
    store: ReplayStore, identity: PreparedIdentity, maxRecords: number, maxBytes: number,
): ReplayRecord[] => {
    if (!identity.eligible) return [];
    return store.withPlanning((planning) => selectVerifiedPlan(planning, identity, maxRecords, maxBytes));
};

const selectVerifiedPlan = (
    store: ReplayPlanningStore, identity: PreparedIdentity, maxRecords: number, maxBytes: number,
): ReplayRecord[] => {
    const boundaries = new Map(identity.prefixes.map((digest, index) => [digest, index]));
    // Candidate payloads are loaded one at a time, never all history hits at once.
    let work = Math.max(1, maxRecords * 4);
    const verified = (end: string): ReplayRecord | null => {
        if (--work < 0) return null;
        const index = boundaries.get(end);
        if (!index || (identity.messages[index - 1] as JsonBody | null)?.role !== 'assistant') return null;
        const record = store.get(identity.scope.digest, end);
        if (!record || record.startDigest !== identity.prefixes[index - 1] ||
            record.envelopeFingerprint !== identity.envelopes[index - 1]) return null;
        store.touchVerified(record);
        return store.canReplay(record) ? record : null;
    };
    for (let index = identity.messages.length; index > 0 && work > 0; index--) {
        if ((identity.messages[index - 1] as JsonBody | null)?.role !== 'assistant') continue;
        const candidate = verified(identity.prefixes[index]!);
        if (!candidate || candidate.priorPlan.length + 1 > maxRecords || candidate.bytes > maxBytes ||
            !store.snapshotAccepted(candidate.scope, candidate.snapshot)) continue;
        const plan: ReplayRecord[] = [];
        let bytes = candidate.bytes;
        let valid = true;
        let previousBoundary = -1;
        for (const descriptor of candidate.priorPlan) {
            const boundary = boundaries.get(descriptor.endDigest) ?? -1;
            if (boundary <= previousBoundary || boundary >= index) { valid = false; break; }
            const ancestor = verified(descriptor.endDigest);
            if (!ancestor || !descriptorMatches(ancestor, descriptor) || ancestor.generation !== candidate.generation ||
                ancestor.priorPlan.length !== plan.length || ancestor.priorPlan.some((d, i) => !descriptorMatches(plan[i]!, d))) {
                valid = false;
                break;
            }
            bytes += ancestor.bytes;
            if (bytes > maxBytes) { valid = false; break; }
            plan.push(ancestor);
            previousBoundary = boundary;
        }
        if (valid) return [...plan, candidate];
    }
    // Exhausting cache-state-dependent work never skips the intent/observation contract.
    return [];
};

/** Preserve message boundaries until replacement; never hash reconstructed hidden input. */
export const reconstructInput = (identity: PreparedIdentity, records: ReplayRecord[]): JsonBody[] | null => {
    const replacements = new Map(records.map((record) => [record.endDigest, record]));
    const input: JsonBody[] = [];
    for (let index = 0; index < identity.messages.length; index++) {
        const record = replacements.get(identity.prefixes[index + 1]!);
        input.push(...(record ? record.output : chatMessagesToInput([identity.messages[index]])));
    }
    const calls = new Set<string>();
    const results = new Set<string>();
    for (const item of input) {
        if (item.type === 'function_call') {
            if (typeof item.call_id !== 'string' || calls.has(item.call_id)) return null;
            calls.add(item.call_id);
        } else if (item.type === 'function_call_output') {
            if (typeof item.call_id !== 'string' || !calls.has(item.call_id) || results.has(item.call_id)) return null;
            results.add(item.call_id);
        }
    }
    if ([...calls].some((id) => !results.has(id))) return null;
    return input;
};
