import type { CacheConfig } from './types.ts';

/** Bounds the optional cache, not total relay concurrency. Never preallocates these bytes. */
export class CacheAdmission {
    private retained = 0;
    private active = 0;
    readonly hotBytes: number;
    readonly replayScratchBytes: number;
    readonly workspaceBytes: number;
    private readonly available: number;
    private readonly config: CacheConfig;

    constructor(config: CacheConfig) {
        this.config = config;
        this.hotBytes = Math.min(4 * 1024 * 1024, Math.floor(config.memoryBytes / 32));
        this.replayScratchBytes = Math.min(config.maxReplayBytes, Math.floor(config.memoryBytes / 16));
        // A selected plan and its transactional validation can coexist. Reserve both, once,
        // alongside preflight scratch even while other streams fill their per-session leases.
        this.workspaceBytes = this.hotBytes + config.limits.maxScratchBytes + this.replayScratchBytes * 2;
        if (config.enabled && this.workspaceBytes + 64 * 1024 > config.memoryBytes) {
            throw new RangeError('REASONING_CACHE_MEMORY_MAX_BYTES must fit the shared cache workspace');
        }
        this.available = Math.max(0, config.memoryBytes - this.workspaceBytes);
    }

    private sessionBytes(canonicalBytes: number): number {
        if (!Number.isSafeInteger(canonicalBytes) || canonicalBytes < 0) throw new RangeError('Invalid measured history size');
        return 64 * 1024 + this.config.maxEntryBytes * 2 + canonicalBytes * 2 + this.replayScratchBytes / 8;
    }

    refusalReason(canonicalBytes: number): 'maxConcurrent' | 'memory' | null {
        const bytes = this.sessionBytes(canonicalBytes);
        if (this.active >= this.config.maxConcurrent) return 'maxConcurrent';
        return bytes > this.available - this.retained ? 'memory' : null;
    }

    reserve(canonicalBytes: number): (() => void) | null {
        // Capture/observation plus measured request serialization; no worst-case history lease.
        const bytes = this.sessionBytes(canonicalBytes);
        if (this.refusalReason(canonicalBytes)) return null;
        this.active++;
        this.retained += bytes;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.active--;
            this.retained -= bytes;
        };
    }

    get activeSessions(): number { return this.active; }
    get retainedBytes(): number { return this.retained; }
}

export class CacheUnavailableError extends Error {
    constructor(cause?: unknown) {
        super('Reasoning cache safety storage is unavailable', { cause });
        this.name = 'CacheUnavailableError';
    }
}
