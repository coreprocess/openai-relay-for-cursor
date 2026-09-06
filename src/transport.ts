import type { ServerResponse } from 'node:http';
import type { RelayConfig } from './config.ts';

export type TransportLimits = {
    idleTimeoutMs: number; deliveryTimeoutMs: number;
    maxRequestBytes: number; maxResponseBytes: number; maxSseEventBytes: number;
};
export const transportLimits = (config: RelayConfig): TransportLimits => {
    const limits = {
        idleTimeoutMs: config.cache.idleTimeoutMs, deliveryTimeoutMs: config.cache.deliveryTimeoutMs,
        maxRequestBytes: 64 * 1024 * 1024, maxResponseBytes: 64 * 1024 * 1024, maxSseEventBytes: 8 * 1024 * 1024,
        ...config.transport,
    };
    for (const [name, value] of Object.entries(limits)) {
        if (!Number.isSafeInteger(value) || value <= 0 || (name.endsWith('Ms') && value > 2_147_483_647)) {
            throw new Error(`Invalid transport limit: ${name}`);
        }
    }
    return limits;
};

/** Transport protection is independent of optional cache admission. */
export class RequestTransport {
    readonly controller = new AbortController();
    readonly limits: TransportLimits;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private disposed = false;
    private delivery = false;
    private readonly response: ServerResponse;

    constructor(response: ServerResponse, limits: TransportLimits) {
        this.response = response;
        this.limits = limits;
        response.once('finish', this.finish);
        response.once('close', this.close);
        response.once('error', this.abort);
        if (response.destroyed) this.abort(); else this.progress();
    }
    private arm(ms: number): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.abort(); this.response.destroy(); }, ms);
        this.timer.unref();
    }
    progress = (): void => {
        if (!this.disposed && !this.delivery) this.arm(this.limits.idleTimeoutMs);
    };
    beginDelivery = (): void => {
        if (this.disposed) return;
        this.delivery = true;
        this.arm(this.limits.deliveryTimeoutMs);
    };
    abort = (): void => { this.controller.abort(); this.dispose(); };
    private finish = (): void => { this.dispose(); };
    private close = (): void => {
        if (!this.response.writableFinished) this.abort(); else this.dispose();
    };
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.timer) clearTimeout(this.timer);
        this.response.off('finish', this.finish);
        this.response.off('close', this.close);
        this.response.off('error', this.abort);
    }
}
