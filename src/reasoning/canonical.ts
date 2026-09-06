import { createHash, type Hash } from 'node:crypto';
import { CanonicalBudget, DEFAULT_HISTORY_LIMITS } from './canonicalBudget.ts';
import { canonicalEntries, JoinedText } from './canonicalShape.ts';
import { emitCanonical, measureCanonical } from './canonicalWalk.ts';
import type { HistoryLimits } from './types.ts';

export { CanonicalLimitError } from './canonicalBudget.ts';
export { compareCanonicalKeys } from './canonicalShape.ts';
export const HISTORY_DOMAIN = 'openai-relay/reasoning-history/v1\0';
export const FINGERPRINT_DOMAIN = 'openai-relay/canonical-json/v1\0';

/** Unsigned 64-bit big-endian UTF-8 byte count; never a JavaScript string length. */
export const frameLength = (length: number): Buffer => {
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('Invalid canonical frame length');
    const frame = Buffer.alloc(8);
    frame.writeBigUInt64BE(BigInt(length));
    return frame;
};
export const fingerprintMeasured = (value: unknown, length: number, envelope = false, target?: Hash): string => {
    const hash = createHash('sha256').update(FINGERPRINT_DOMAIN).update(frameLength(length));
    target?.update(frameLength(length));
    emitCanonical(value, (chunk) => { hash.update(chunk, 'utf8'); target?.update(chunk, 'utf8'); }, envelope ? 'envelope' : 'raw');
    return hash.digest('hex');
};

/** Raw payload fingerprint. Envelope callers explicitly use normalizeEnvelope or envelope mode. */
export const canonicalFingerprint = (value: unknown, limits: HistoryLimits = DEFAULT_HISTORY_LIMITS): string => {
    const length = measureCanonical(value, new CanonicalBudget(limits));
    return fingerprintMeasured(value, length);
};

/** Standalone convenience projection; the identity hot path uses a lazy streaming view instead. */
export const normalizeEnvelope = (value: unknown): unknown => {
    const budget = new CanonicalBudget();
    const bytes = measureCanonical(value, budget, 'envelope');
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    // The optional materialized helper pays for its copies; prepareIdentity never uses this path.
    budget.reserve(bytes * 2 + budget.nodes * 128);
    const result: Record<string, unknown> = {};
    for (const entry of canonicalEntries(value as Record<string, unknown>, 'envelope')) {
        let child = entry.value;
        if (child instanceof JoinedText) child = [...child.parts()].join('');
        if (entry.mode === 'calls' && Array.isArray(child)) {
            child = child.map((call, index) => {
                if (call === null || typeof call !== 'object' || Array.isArray(call)) return call;
                return Object.fromEntries([...canonicalEntries(call as Record<string, unknown>, index)].map((entry) => [entry.key, entry.value]));
            });
        }
        Object.defineProperty(result, entry.key, { value: child, enumerable: true, writable: true, configurable: true });
    }
    return result;
};
