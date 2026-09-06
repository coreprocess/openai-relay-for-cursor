import type { ServerResponse } from 'node:http';
import type { JsonBody } from '../http.ts';
import { logLine } from '../log.ts';
import type { ResponsesObject, ResponsesStreamEvent } from '../responsesTypes.ts';
import { canonicalFingerprint } from './canonical.ts';
import { OutputCapture } from './capture.ts';
import { ProgressDeadline } from './lifecycle.ts';
import type { ReplayStore } from './store.ts';
import type { CacheConfig, PreparedIdentity } from './types.ts';

/** One dispatched generation; no asynchronous gap is allowed before its intent exists. */
export class ReplaySession {
    readonly controller = new AbortController();
    readonly capture: OutputCapture;
    private phase: 'generation' | 'delivery' | 'resolved' = 'generation';
    private readonly deadline: ProgressDeadline;
    private response: ServerResponse | undefined;
    private requestEnded = false;
    private leaseReleased = false;
    private nextRenewal = 0;
    private observationAbandoned = false;

    private readonly store: ReplayStore;
    private readonly id: string;
    private readonly identity: Pick<PreparedIdentity, 'eligible' | 'append'>;
    private readonly config: CacheConfig;
    private readonly released: () => void;
    constructor(store: ReplayStore, id: string, identity: PreparedIdentity, config: CacheConfig, released: () => void) {
        this.store = store;
        this.id = id;
        // The request handler already owns visible history; capture needs only the final hash state.
        this.identity = { eligible: identity.eligible, append: identity.append };
        this.config = config;
        this.released = released;
        this.capture = new OutputCapture(config.maxEntryBytes);
        this.deadline = new ProgressDeadline({
            idleTimeoutMs: config.idleTimeoutMs, deliveryTimeoutMs: config.deliveryTimeoutMs,
            onExpire: () => { this.abort(); this.response?.destroy(); },
        });
    }

    bind(response: ServerResponse): void {
        this.response = response;
        response.once('finish', this.onFinish);
        response.once('close', this.onClose);
        response.once('error', this.onError);
        if (response.destroyed) this.abort();
    }
    private onFinish = (): void => {
        if (this.phase === 'delivery') this.resolve();
        else if (this.phase !== 'resolved') this.abort();
    };
    private onClose = (): void => { if (!this.response?.writableFinished) this.abort(); };
    private onError = (): void => { this.abort(); };

    progress(): void {
        if (this.phase !== 'generation') return;
        if (!this.deadline.progress()) return;
        // Live expiry uses the monotonic watchdog; crash recovery poisons every unresolved
        // intent. Coalesce diagnostic deadline writes instead of fsync on every SSE fragment.
        const now = performance.now();
        if (!this.observationAbandoned && now >= this.nextRenewal) {
            this.store.renew(this.id, Date.now() + this.config.idleTimeoutMs);
            this.nextRenewal = now + Math.min(5000, this.config.idleTimeoutMs / 4);
        }
    }
    event(event: ResponsesStreamEvent): void { this.capture.addEvent(event); }
    frame(frame: string): void { this.capture.addFrame(frame); }
    json(value: unknown): void { this.capture.addJson(value); }

    complete(response?: ResponsesObject): void {
        if (this.phase !== 'generation') throw new Error('Generation is no longer active');
        const result = this.capture.finish(response);
        if (!result.complete) {
            // Capture refusal is a cache miss, not permission to abort a valid visible reply.
            // Poison before terminal output, retain the transport lease/watchdog until finish.
            this.finishWithoutCapture();
            return;
        }
        let endDigest: string | null = null;
        let envelopeFingerprint: string | null = null;
        if (result.envelope !== null) {
            try { ({ endDigest, envelopeFingerprint } = this.identity.append(result.envelope)); }
            catch { /* Unknown projection must poison the position, never silently miss observation. */ }
        }
        let fingerprint: string | null = null;
        try { if (result.output) fingerprint = canonicalFingerprint(result.output, this.config.limits); } catch { /* observe-only */ }
        this.store.observe(this.id, {
            endDigest, envelopeFingerprint, output: result.output as JsonBody[] | null,
            payloadFingerprint: fingerprint, snapshot: result.snapshot,
            admit: this.identity.eligible && result.admissible && fingerprint !== null,
            deliveryDeadline: Date.now() + this.config.deliveryTimeoutMs,
        });
        this.phase = 'delivery';
        if (!this.deadline.beginDelivery()) this.abort();
    }
    /** An upstream terminal failure/incomplete response is still delivered before transport closes. */
    finishWithoutCapture(): void {
        if (this.phase !== 'generation') return;
        this.store.poison(this.id);
        this.observationAbandoned = true;
        this.phase = 'delivery';
        if (!this.deadline.beginDelivery()) this.abort();
    }
    rejectReplay(): void { if (this.phase !== 'resolved') this.store.rejectReplay(this.id); }
    ensureCompleted(): void { if (this.phase === 'generation') this.abort(); }
    requestFinished(): void {
        this.requestEnded = true;
        this.releaseIfFinished();
    }
    private releaseIfFinished(): void {
        if (this.phase !== 'resolved' || (!this.requestEnded && this.response) || this.leaseReleased) return;
        this.leaseReleased = true;
        this.released();
    }
    abort(): void {
        if (this.phase === 'resolved') return;
        this.controller.abort();
        try { if (!this.observationAbandoned) this.store.poison(this.id); }
        catch { logLine('reasoning cache poison failed; durable recovery required'); }
        finally { this.dispose(); }
    }
    private resolve(): void {
        try { if (!this.observationAbandoned) this.store.resolve(this.id); }
        catch { logLine('reasoning cache delivery resolution failed; durable intent retained'); }
        finally { this.dispose(); }
    }
    private dispose(): void {
        this.phase = 'resolved';
        this.deadline.dispose();
        this.response?.off('finish', this.onFinish);
        this.response?.off('close', this.onClose);
        this.response?.off('error', this.onError);
        this.releaseIfFinished();
    }
}
