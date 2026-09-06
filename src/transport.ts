import type { ServerResponse } from 'node:http';
import type { RelayConfig } from './config.ts';
import { RelayFailure } from './failure.ts';

export type TransportLimits = {
    idleTimeoutMs: number; deliveryTimeoutMs: number; sseKeepaliveMs: number;
    maxRequestBytes: number; maxResponseBytes: number; maxSseEventBytes: number;
};
export const transportLimits = (config: RelayConfig): TransportLimits => {
    const limits = {
        idleTimeoutMs: config.cache.idleTimeoutMs, deliveryTimeoutMs: config.cache.deliveryTimeoutMs, sseKeepaliveMs: 15000,
        maxRequestBytes: 64 * 1024 * 1024, maxResponseBytes: 64 * 1024 * 1024, maxSseEventBytes: 8 * 1024 * 1024,
        ...config.transport,
    };
    for (const [name, value] of Object.entries(limits)) {
        if (!Number.isSafeInteger(value) || value < (name === 'sseKeepaliveMs' ? 0 : 1) || (name.endsWith('Ms') && value > 2_147_483_647)) {
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
    private readonly startedAt = performance.now();
    private lastProgressAt = this.startedAt;
    private upstreamHeadersAt: number | null = null;
    private upstreamStatus: number | null = null;
    private closedAt: number | null = null;
    private observedClose: 'finish' | 'client_close' | 'client_write_error' | null = null;
    private lastClientFrameAt: number | null = null;
    private visibleFrames = 0;
    private keepalives = 0;

    constructor(response: ServerResponse, limits: TransportLimits) {
        this.response = response;
        this.limits = limits;
        response.once('finish', this.finish);
        response.once('close', this.close);
        response.once('error', this.onClientError);
        if (response.destroyed) this.close(); else this.progress();
    }
    private arm(ms: number): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.abort(new RelayFailure(this.delivery ? 'delivery_timeout' : 'upstream_idle_timeout'));
            this.response.destroy();
        }, ms);
        this.timer.unref();
    }
    progress = (): void => {
        if (!this.disposed && !this.delivery) {
            this.lastProgressAt = performance.now();
            this.arm(this.limits.idleTimeoutMs);
        }
    };
    beginDelivery = (): void => {
        if (this.disposed) return;
        this.delivery = true;
        this.arm(this.limits.deliveryTimeoutMs);
    };
    receivedHeaders(status: number): void { this.upstreamStatus = status; this.upstreamHeadersAt = performance.now(); }
    clientFrame(visible = false): void {
        this.lastClientFrameAt = performance.now();
        if (visible) this.visibleFrames++;
    }
    keepalive(): void { this.keepalives++; }
    diagnostics() {
        const now = this.closedAt ?? performance.now();
        return {
            elapsedMs: Math.round(now - this.startedAt),
            upstreamStatus: this.upstreamStatus,
            sinceUpstreamHeadersMs: this.upstreamHeadersAt === null ? null : Math.round(now - this.upstreamHeadersAt),
            upstreamIdleMs: Math.max(0, Math.round(now - this.lastProgressAt)),
            clientDataIdleMs: this.lastClientFrameAt === null ? null : Math.max(0, Math.round(now - this.lastClientFrameAt)),
            visibleFrames: this.visibleFrames, keepalives: this.keepalives,
            downstream: this.observedClose, localFinished: this.response.writableFinished, phase: this.delivery ? 'delivery' : 'generation',
        };
    }
    abort = (reason: unknown = new RelayFailure('request_aborted')): void => { this.controller.abort(reason); this.dispose(); };
    private finish = (): void => {
        this.closedAt ??= performance.now(); this.observedClose ??= 'finish'; this.dispose();
    };
    private onClientError = (): void => {
        this.closedAt ??= performance.now(); this.observedClose ??= 'client_write_error';
        this.abort(new RelayFailure('client_write_error'));
    };
    private close = (): void => {
        this.closedAt ??= performance.now(); this.observedClose ??= this.response.writableFinished ? 'finish' : 'client_close';
        if (!this.response.writableFinished) this.abort(new RelayFailure('client_disconnected')); else this.dispose();
    };
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.timer) clearTimeout(this.timer);
        this.response.off('finish', this.finish);
        this.response.off('close', this.close);
        this.response.off('error', this.onClientError);
    }
}
