import { createHmac } from 'node:crypto';
import type { JsonBody } from '../http.ts';
import { CanonicalBudget } from './canonicalBudget.ts';
import { fingerprintMeasured, frameLength } from './canonical.ts';
import { CanonicalArrayView, CanonicalObjectView, isOmitted } from './canonicalShape.ts';
import { emitCanonical, measureCanonical } from './canonicalWalk.ts';
import type { HistoryLimits, IdentityContext, ScopeIdentity } from './types.ts';

export const IDENTITY_VERSION = 'reasoning-replay/v1:fixed-store-false:encrypted-content';
const ENCRYPTED_CONTENT = 'reasoning.encrypted_content';
const fixedInclude = (include: unknown): unknown => {
    if (include !== undefined && !Array.isArray(include)) return include;
    return new CanonicalArrayView(function* () {
        // Yield before retaining; preflight charges the canonical unique values before Set growth.
        const seen = new Set<unknown>();
        if (Array.isArray(include)) {
            for (const item of include) {
                if (item === ENCRYPTED_CONTENT || seen.has(item)) continue;
                yield item;
                seen.add(item);
            }
        }
        yield ENCRYPTED_CONTENT;
    }, (item) => 128 + (typeof item === 'string' ? item.length * 4 : 0));
};
export const effectiveConfiguration = (outbound: JsonBody): CanonicalObjectView => new CanonicalObjectView(function* () {
    for (const key in outbound) {
        if (!Object.hasOwn(outbound, key) || ['input', 'stream', 'store', 'include'].includes(key)) continue;
        if (!isOmitted(outbound[key])) yield { key, value: outbound[key], mode: 'raw' };
    }
    yield { key: 'store', value: false, mode: 'raw' };
    yield { key: 'include', value: fixedInclude(outbound.include), mode: 'raw' };
});
const limitsView = (limits: HistoryLimits): CanonicalObjectView => new CanonicalObjectView(function* () {
    for (const key of ['maxBytes', 'maxMessages', 'maxNodes', 'maxDepth', 'maxLookups', 'maxScratchBytes'] as const) {
        yield { key, value: limits[key], mode: 'raw' };
    }
});
export const deriveScope = (outbound: JsonBody, context: IdentityContext, budget: CanonicalBudget): {
    scope: ScopeIdentity; seed: unknown; length: number;
} => {
    // Bound configured strings before URL/HMAC allocate or parse them; credentials are never retained.
    const contextBudget = new CanonicalBudget(context.limits);
    measureCanonical([context.upstreamOrigin, context.endpoint, context.apiKey, context.relayToken, context.secret, context.openaiBeta], contextBudget);
    const privateDigest = (domain: string, value: unknown): string => {
        const length = measureCanonical(value, new CanonicalBudget(context.limits));
        const hash = createHmac('sha256', context.secret).update(domain).update(frameLength(length));
        emitCanonical(value, (chunk) => hash.update(chunk));
        return hash.digest('hex');
    };
    const credential = privateDigest('credential\0', context.apiKey);
    const authorization = privateDigest('authorization\0', context.relayToken);
    const callerValue = typeof outbound.safety_identifier === 'string' ? outbound.safety_identifier :
        typeof outbound.user === 'string' ? outbound.user : null;
    measureCanonical(callerValue, new CanonicalBudget(context.limits));
    const caller = privateDigest('caller\0', callerValue);
    const origin = new URL(context.upstreamOrigin);
    origin.pathname = origin.pathname.replace(/\/+$/, '');
    const seed = {
        version: IDENTITY_VERSION, limits: limitsView(context.limits), upstream: origin.href.replace(/\/+$/, ''),
        endpoint: context.endpoint ?? '/v1/responses', credential, authorization, caller,
        headers: { 'openai-beta': context.openaiBeta ?? null }, configuration: effectiveConfiguration(outbound),
    };
    const length = measureCanonical(seed, budget);
    return {
        scope: { digest: fingerprintMeasured(seed, length), credential, model: typeof outbound.model === 'string' ? outbound.model : '', caller },
        seed, length,
    };
};
