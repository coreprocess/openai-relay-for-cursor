import type { CacheConfig } from './types.ts';

/** Simple optional-cache admission. These are byte allowances, not a process RSS guarantee. */
export class CacheAdmission {
    private retained = 0;
    private active = 0;
    readonly hotBytes: number;
    readonly workspaceBytes: number;
    private readonly available: number;
    private readonly config: CacheConfig;

    constructor(config: CacheConfig) {
        this.config = config;
        this.hotBytes = Math.min(4 * 1024 * 1024, Math.floor(config.memoryBytes / 32));
        // Synchronous preparation has one shared allowance. No hidden division of replay size.
        this.workspaceBytes = this.hotBytes + config.limits.maxScratchBytes + config.maxReplayBytes;
        if (config.enabled && this.workspaceBytes + 64 * 1024 > config.memoryBytes) {
            throw new RangeError('REASONING_CACHE_MEMORY_MAX_BYTES must fit the shared cache workspace');
        }
        this.available = Math.max(0, config.memoryBytes - this.workspaceBytes);
    }

    private sessionBytes(canonicalBytes: number, replayBytes: number): number {
        for (const value of [canonicalBytes, replayBytes]) {
            if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid measured request size');
        }
        return 64 * 1024 + this.config.maxEntryBytes * 2 + (canonicalBytes + replayBytes) * 2;
    }

    refusalReason(canonicalBytes: number, replayBytes = 0): 'maxConcurrent' | 'memory' | null {
        const bytes = this.sessionBytes(canonicalBytes, replayBytes);
        if (this.active >= this.config.maxConcurrent) return 'maxConcurrent';
        return bytes > this.available - this.retained ? 'memory' : null;
    }

    reserve(canonicalBytes: number, replayBytes = 0): (() => void) | null {
        const bytes = this.sessionBytes(canonicalBytes, replayBytes);
        if (this.refusalReason(canonicalBytes, replayBytes)) return null;
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
