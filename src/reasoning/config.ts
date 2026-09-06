import { resolve } from 'node:path';
import type { CacheConfig } from './types.ts';

const positiveInteger = (env: NodeJS.ProcessEnv, name: string, fallback: number, minimum = 1): number => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < minimum || (name.endsWith('_MS') && value > 2_147_483_647)) {
        throw new Error(`${name} must be an integer >= ${minimum}`);
    }
    return value;
};

export const loadCacheConfig = (env: NodeJS.ProcessEnv = process.env): CacheConfig => ({
    enabled: env.REASONING_CACHE_ENABLED === '1',
    dbPath: resolve(env.REASONING_CACHE_DB_PATH ?? 'data/reasoning-cache.sqlite'),
    idleDays: positiveInteger(env, 'REASONING_CACHE_IDLE_DAYS', 30, 30),
    memoryBytes: positiveInteger(env, 'REASONING_CACHE_MEMORY_MAX_BYTES', 128 * 1024 * 1024),
    diskBytes: positiveInteger(env, 'REASONING_CACHE_DISK_MAX_BYTES', 1024 * 1024 * 1024),
    reserveBytes: positiveInteger(env, 'REASONING_CACHE_RESERVE_BYTES', 64 * 1024 * 1024),
    maxEntryBytes: positiveInteger(env, 'REASONING_CACHE_ENTRY_MAX_BYTES', 4 * 1024 * 1024),
    maxReplayBytes: positiveInteger(env, 'REASONING_CACHE_REPLAY_MAX_BYTES', 16 * 1024 * 1024),
    maxPlanRecords: positiveInteger(env, 'REASONING_CACHE_PLAN_MAX_RECORDS', 256),
    maxConcurrent: positiveInteger(env, 'REASONING_CACHE_MAX_CONCURRENT', 8),
    idleTimeoutMs: positiveInteger(env, 'REASONING_CACHE_IDLE_TIMEOUT_MS', 15 * 60 * 1000),
    deliveryTimeoutMs: positiveInteger(env, 'REASONING_CACHE_DELIVERY_TIMEOUT_MS', 30_000),
    limits: {
        maxBytes: positiveInteger(env, 'REASONING_CACHE_HISTORY_MAX_BYTES', 32 * 1024 * 1024),
        maxMessages: positiveInteger(env, 'REASONING_CACHE_HISTORY_MAX_MESSAGES', 6400),
        maxNodes: positiveInteger(env, 'REASONING_CACHE_HISTORY_MAX_NODES', 2_000_000),
        maxDepth: positiveInteger(env, 'REASONING_CACHE_HISTORY_MAX_DEPTH', 64),
        maxLookups: positiveInteger(env, 'REASONING_CACHE_HISTORY_MAX_LOOKUPS', 4000),
        maxScratchBytes: positiveInteger(env, 'REASONING_CACHE_SCRATCH_MAX_BYTES', 16 * 1024 * 1024),
    },
});
