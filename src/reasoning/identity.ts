import { createHash } from 'node:crypto';
import type { JsonBody } from '../http.ts';
import { CanonicalBudget, CanonicalLimitError } from './canonicalBudget.ts';
import { fingerprintMeasured, frameLength, HISTORY_DOMAIN } from './canonical.ts';
import { isObject } from './canonicalShape.ts';
import { emitCanonical, measureCanonical } from './canonicalWalk.ts';
import { isReplayEligible } from './eligibility.ts';
import { deriveScope } from './identityScope.ts';
import type { IdentityContext, PreparedIdentity } from './types.ts';

/** Hex digests, array slots, per-envelope lengths, and retained hash state (conservative accounting). */
const retainedScratch = (messages: number): number => 2048 + (messages + 1) * 320;

export const prepareIdentity = (chat: JsonBody, outbound: JsonBody, context: IdentityContext): PreparedIdentity => {
    const messages = Array.isArray(chat.messages) ? chat.messages : [];
    const messageCount = messages.length;
    const limits = { ...context.limits };
    if (messages.length > limits.maxMessages) throw new CanonicalLimitError('maxMessages');
    const budget = new CanonicalBudget(limits, retainedScratch(messages.length));
    const { scope, seed, length } = deriveScope(outbound, { ...context, limits }, budget);
    // Measure the complete canonical history before allocating digest lists or sorting any messages.
    let lookups = 0;
    for (const message of messages) {
        if (isObject(message) && message.role === 'assistant' && ++lookups > limits.maxLookups) {
            throw new CanonicalLimitError('maxLookups');
        }
        measureCanonical(message, budget, 'envelope');
    }
    const state = createHash('sha256').update(HISTORY_DOMAIN).update(frameLength(length));
    emitCanonical(seed, (chunk) => state.update(chunk));
    const prefixes = [state.copy().digest('hex')];
    const envelopes: string[] = [];
    // Framing requires each length before its bytes, not a length trailer or raw UTF-16 count.
    for (const message of messages) {
        const length = measureCanonical(message, new CanonicalBudget(limits), 'envelope');
        envelopes.push(fingerprintMeasured(message, length, true, state));
        prefixes.push(state.copy().digest('hex'));
    }
    const append: PreparedIdentity['append'] = (message) => {
        if (messageCount + 1 > limits.maxMessages) throw new CanonicalLimitError('maxMessages');
        if (isObject(message) && message.role === 'assistant' && lookups + 1 > limits.maxLookups) {
            throw new CanonicalLimitError('maxLookups');
        }
        const appendedBudget = budget.copy(retainedScratch(messageCount + 1));
        const length = measureCanonical(message, appendedBudget, 'envelope');
        const copy = state.copy();
        const envelopeFingerprint = fingerprintMeasured(message, length, true, copy);
        return { endDigest: copy.digest('hex'), envelopeFingerprint };
    };
    return { scope, eligible: isReplayEligible(chat, outbound), messages, prefixes, envelopes, canonicalBytes: budget.bytes, append };
};
