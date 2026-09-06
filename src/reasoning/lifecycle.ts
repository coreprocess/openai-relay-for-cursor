export type DeadlinePhase = 'generation' | 'delivery';
export type DeadlineUpdate = { phase: DeadlinePhase; deadline: number };
export type DeadlineOptions = {
    idleTimeoutMs?: number;
    deliveryTimeoutMs?: number;
    now?: () => number;
    schedule?: (callback: () => void, delayMs: number) => unknown;
    cancel?: (handle: unknown) => void;
    onRenew?: (update: DeadlineUpdate) => void;
    onExpire: (update: DeadlineUpdate) => void;
};

/** Generation has only a renewable idle deadline; delivery has its own fixed deadline. */
export class ProgressDeadline {
    private readonly options: DeadlineOptions;
    private readonly now: () => number;
    private readonly schedule: (callback: () => void, delayMs: number) => unknown;
    private readonly cancel: (handle: unknown) => void;
    private readonly idleMs: number;
    private readonly deliveryMs: number;
    private currentPhase: DeadlinePhase = 'generation';
    private expiresAt = 0;
    private revision = 0;
    private handle: unknown;
    private active = true;
    private lastNow = -Infinity;

    constructor(options: DeadlineOptions) {
        this.options = options;
        this.now = options.now ?? (() => performance.now());
        this.schedule = options.schedule ?? ((callback, delay) => {
            const timer = setTimeout(callback, delay);
            timer.unref();
            return timer;
        });
        this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
        this.idleMs = options.idleTimeoutMs ?? 15 * 60 * 1000;
        this.deliveryMs = options.deliveryTimeoutMs ?? 30_000;
        if (![this.idleMs, this.deliveryMs].every((value) => Number.isFinite(value) && value > 0 && value <= 2_147_483_647)) {
            throw new RangeError('Deadline durations must be positive finite timer durations');
        }
        if (!!options.schedule !== !!options.cancel) throw new TypeError('Provide both schedule and cancel');
        this.renew(this.time() + this.idleMs);
    }

    get phase(): DeadlinePhase { return this.currentPhase; }
    get deadline(): number { return this.expiresAt; }
    get disposed(): boolean { return !this.active; }

    private time(): number {
        const now = this.now();
        if (!Number.isFinite(now)) throw new RangeError('Clock must return a finite monotonic timestamp');
        this.lastNow = Math.max(now, this.lastNow);
        return this.lastNow;
    }

    private renew(deadline: number): void {
        this.expiresAt = deadline;
        const revision = ++this.revision;
        if (this.handle !== undefined) this.cancel(this.handle);
        this.handle = this.schedule(() => this.check(revision), Math.max(0, deadline - this.time()));
        try { this.options.onRenew?.({ phase: this.currentPhase, deadline }); }
        catch (error) { this.dispose(); throw error; }
    }

    private check(revision: number): void {
        if (!this.active || revision !== this.revision) return;
        if (this.handle !== undefined) this.cancel(this.handle);
        this.handle = undefined;
        const remaining = this.expiresAt - this.time();
        if (remaining > 0) {
            this.handle = this.schedule(() => this.check(revision), remaining);
            return;
        }
        const update = { phase: this.currentPhase, deadline: this.expiresAt };
        this.dispose();
        this.options.onExpire(update);
    }

    /** Only upstream generation progress renews idle time; late callbacks cannot extend delivery. */
    progress(): boolean {
        if (!this.active || this.currentPhase !== 'generation') return false;
        const now = this.time();
        if (now >= this.expiresAt) { this.check(this.revision); return false; }
        this.renew(now + this.idleMs);
        return this.active && this.currentPhase === 'generation';
    }

    /** Call once when semantic output is ready, before awaiting client delivery. */
    beginDelivery(): boolean {
        if (!this.active || this.currentPhase !== 'generation') return false;
        const now = this.time();
        if (now >= this.expiresAt) { this.check(this.revision); return false; }
        this.currentPhase = 'delivery';
        this.renew(now + this.deliveryMs);
        return this.active;
    }

    dispose(): void {
        if (!this.active) return;
        this.active = false;
        this.revision++;
        if (this.handle !== undefined) this.cancel(this.handle);
        this.handle = undefined;
    }
}
