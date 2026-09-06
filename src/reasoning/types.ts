import type { JsonBody } from '../http.ts';

export type ReplayDescriptor = { startDigest: string; endDigest: string; payloadFingerprint: string };
export type ReplayRecord = ReplayDescriptor & {
    scope: string;
    generation: number;
    envelopeFingerprint: string;
    output: JsonBody[];
    priorPlan: ReplayDescriptor[];
    producingIntentId: string;
    snapshot: string;
    createdAt: number;
    touchedAt: number;
    bytes: number;
};
export type ScopeIdentity = { digest: string; credential: string; model: string; caller: string };
export type HistoryLimits = {
    maxBytes: number;
    maxMessages: number;
    maxNodes: number;
    maxDepth: number;
    maxLookups: number;
    maxScratchBytes: number;
};
export type PreparedIdentity = {
    scope: ScopeIdentity;
    eligible: boolean;
    messages: unknown[];
    prefixes: string[];
    envelopes: string[];
    /** Measured canonical scope plus history bytes, not a configured worst-case ceiling. */
    canonicalBytes: number;
    append: (message: unknown) => { endDigest: string; envelopeFingerprint: string };
};
export type IdentityContext = {
    upstreamOrigin: string;
    endpoint?: string;
    apiKey: string;
    relayToken: string;
    secret: string;
    openaiBeta?: string;
    limits: HistoryLimits;
};
export type CacheConfig = {
    enabled: boolean;
    dbPath: string;
    idleDays: number;
    memoryBytes: number;
    diskBytes: number;
    reserveBytes: number;
    maxEntryBytes: number;
    maxReplayBytes: number;
    maxPlanRecords: number;
    maxConcurrent: number;
    idleTimeoutMs: number;
    deliveryTimeoutMs: number;
    limits: HistoryLimits;
};
export type Observation = {
    endDigest: string | null;
    envelopeFingerprint: string | null;
    output: JsonBody[] | null;
    payloadFingerprint: string | null;
    snapshot: string;
    admit: boolean;
    deliveryDeadline: number;
};
export type StoreOptions = {
    path: string;
    idleDays: number;
    diskBytes: number;
    reserveBytes: number;
    memoryBytes: number;
    maxEntryBytes: number;
    maxReplayBytes?: number;
    maxPlanRecords?: number;
    wallNow?: () => number;
    monotonicNow?: () => number;
};
