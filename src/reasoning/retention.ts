import { performance } from 'node:perf_hooks';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MIN_IDLE_MS = 30 * DAY_MS;
export const CLEANUP_BATCH_SIZE = 100;
const MAX_CLOCK_DRIFT_MS = 60_000;

/** A restart or discontinuous clock starts a fresh, monotonic deletion embargo. */
export class RetentionClock {
    readonly idleMs: number;
    private readonly wallNow: () => number;
    private readonly monotonicNow: () => number;
    private lastWall: number;
    private lastMonotonic: number;
    private barrierStart: number;

    constructor(idleDays: number, wallNow = Date.now, monotonicNow = () => performance.now()) {
        if (!Number.isFinite(idleDays) || idleDays < 0) throw new Error('Invalid replay retention');
        this.idleMs = Math.max(MIN_IDLE_MS, idleDays * DAY_MS);
        this.wallNow = wallNow;
        this.monotonicNow = monotonicNow;
        this.lastWall = wallNow();
        this.lastMonotonic = monotonicNow();
        this.barrierStart = this.lastMonotonic;
        this.validate(this.lastWall, this.lastMonotonic);
    }

    private validate(wall: number, monotonic: number): void {
        if (!Number.isFinite(wall) || !Number.isFinite(monotonic)) throw new Error('Invalid replay clock');
    }

    private sample(): { wall: number; monotonic: number } {
        const wall = this.wallNow();
        const monotonic = this.monotonicNow();
        this.validate(wall, monotonic);
        const wallElapsed = wall - this.lastWall;
        const monotonicElapsed = monotonic - this.lastMonotonic;
        if (wallElapsed < 0 || monotonicElapsed < 0 || Math.abs(wallElapsed - monotonicElapsed) > MAX_CLOCK_DRIFT_MS) {
            this.barrierStart = monotonic;
        }
        this.lastWall = wall;
        this.lastMonotonic = monotonic;
        return { wall, monotonic };
    }

    now(): number {
        return this.sample().wall;
    }

    deletionCutoff(): number | null {
        const { wall, monotonic } = this.sample();
        if (monotonic - this.barrierStart < MIN_IDLE_MS) return null;
        return wall - this.idleMs;
    }
}
