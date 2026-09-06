import type { HistoryLimits } from './types.ts';

export const DEFAULT_HISTORY_LIMITS: HistoryLimits = {
    maxBytes: 32 * 1024 * 1024, maxMessages: 6400, maxNodes: 2_000_000,
    maxDepth: 64, maxLookups: 4000, maxScratchBytes: 32 * 1024 * 1024,
};
export class CanonicalLimitError extends Error {
    readonly limit: keyof HistoryLimits;
    constructor(limit: keyof HistoryLimits) {
        super(`Canonical identity limit exceeded: ${limit}`);
        this.limit = limit;
        this.name = 'CanonicalLimitError';
    }
}
export class CanonicalBudget {
    bytes = 0;
    nodes = 0;
    scratch = 0;
    readonly limits: HistoryLimits;
    constructor(limits: HistoryLimits = DEFAULT_HISTORY_LIMITS, retainedScratch = 0) {
        this.limits = limits;
        for (const key of ['maxBytes', 'maxMessages', 'maxNodes', 'maxDepth', 'maxLookups', 'maxScratchBytes'] as const) {
            if (!Number.isSafeInteger(limits[key]) || limits[key] < 0) throw new CanonicalLimitError(key);
        }
        // This implementation is recursive; do not let configuration replace a deterministic ceiling with stack overflow.
        if (limits.maxDepth > 256) throw new CanonicalLimitError('maxDepth');
        this.reserve(retainedScratch);
    }
    addBytes(count: number): void {
        this.bytes += count;
        if (this.bytes > this.limits.maxBytes) throw new CanonicalLimitError('maxBytes');
    }
    node(depth: number): void {
        if (++this.nodes > this.limits.maxNodes) throw new CanonicalLimitError('maxNodes');
        if (depth > this.limits.maxDepth) throw new CanonicalLimitError('maxDepth');
    }
    reserve(bytes: number): void {
        this.scratch += bytes;
        if (this.scratch > this.limits.maxScratchBytes) throw new CanonicalLimitError('maxScratchBytes');
    }
    release(bytes: number): void { this.scratch -= bytes; }
    copy(retainedScratch = this.scratch): CanonicalBudget {
        const copy = new CanonicalBudget(this.limits, retainedScratch);
        copy.bytes = this.bytes;
        copy.nodes = this.nodes;
        return copy;
    }
}
