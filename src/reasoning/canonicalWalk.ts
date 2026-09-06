import { CanonicalBudget, CanonicalLimitError } from './canonicalBudget.ts';
import { canonicalEntries, CanonicalArrayView, compareCanonicalKeys, JoinedText, type CanonicalMode } from './canonicalShape.ts';
import { STRING_SCRATCH_BYTES, writeJsonString, type CanonicalSink } from './canonicalString.ts';

const childMode = (mode: CanonicalMode, index: number): CanonicalMode => mode === 'calls' ? index : 'raw';
const primitive = (value: unknown): string => {
    if (typeof value === 'bigint') throw new TypeError('Canonical JSON does not support bigint');
    return typeof value === 'number' || typeof value === 'boolean' ? JSON.stringify(value) : 'null';
};

/** Measure before sorting or hashing. The accounting depends only on the canonical projection. */
export const measureCanonical = (value: unknown, budget: CanonicalBudget, mode: CanonicalMode = 'raw'): number => {
    const before = budget.bytes;
    const active = new WeakSet<object>();
    const count: CanonicalSink = (chunk) => budget.addBytes(Buffer.byteLength(chunk, 'utf8'));
    const walk = (current: unknown, depth: number, context: CanonicalMode): void => {
        budget.node(depth);
        budget.reserve(64);
        if (typeof current === 'string' || current instanceof JoinedText) {
            budget.reserve(STRING_SCRATCH_BYTES);
            writeJsonString(current instanceof JoinedText ? current.parts() : [current], count);
            budget.release(STRING_SCRATCH_BYTES);
        } else if (current === null || typeof current !== 'object') {
            count(primitive(current));
        } else {
            if (active.has(current)) throw new TypeError('Canonical JSON does not support cycles');
            active.add(current);
            count(Array.isArray(current) || current instanceof CanonicalArrayView ? '[]' : '{}');
            if (Array.isArray(current) || current instanceof CanonicalArrayView) {
                if (Array.isArray(current) && current.length > budget.limits.maxNodes - budget.nodes) {
                    throw new CanonicalLimitError('maxNodes');
                }
                let index = 0;
                let scratch = 0;
                for (const child of current instanceof CanonicalArrayView ? current.values() : current) {
                    const retained = current instanceof CanonicalArrayView ? current.itemScratch(child) : 0;
                    budget.reserve(retained); scratch += retained;
                    if (index) count(',');
                    walk(child, depth + 1, childMode(context, index++));
                }
                budget.release(scratch);
            } else {
                let scratch = 0;
                let fields = 0;
                // No Object.keys, entries array, normalized copy, or unbounded allocation before this pass.
                for (const entry of canonicalEntries(current as Record<string, unknown>, context)) {
                    const bytes = 128 + entry.key.length * 4;
                    budget.reserve(bytes); scratch += bytes;
                    if (fields++) count(',');
                    if (fields > budget.limits.maxNodes - budget.nodes) throw new CanonicalLimitError('maxNodes');
                    budget.reserve(STRING_SCRATCH_BYTES);
                    writeJsonString([entry.key], count);
                    budget.release(STRING_SCRATCH_BYTES);
                    count(':');
                }
                for (const entry of canonicalEntries(current as Record<string, unknown>, context)) {
                    walk(entry.value, depth + 1, entry.mode);
                }
                budget.release(scratch);
            }
            active.delete(current);
        }
        budget.release(64);
    };
    walk(value, 1, mode);
    return budget.bytes - before;
};

/** Only call after measureCanonical succeeds on the same immutable value. */
export const emitCanonical = (value: unknown, sink: CanonicalSink, mode: CanonicalMode = 'raw'): void => {
    if (typeof value === 'string' || value instanceof JoinedText) {
        writeJsonString(value instanceof JoinedText ? value.parts() : [value], sink); return;
    }
    if (value === null || typeof value !== 'object') { sink(primitive(value)); return; }
    if (Array.isArray(value) || value instanceof CanonicalArrayView) {
        sink('[');
        let index = 0;
        for (const child of value instanceof CanonicalArrayView ? value.values() : value) {
            if (index) sink(',');
            emitCanonical(child, sink, childMode(mode, index++));
        }
        sink(']'); return;
    }
    const entries = [...canonicalEntries(value as Record<string, unknown>, mode)];
    entries.sort((a, b) => compareCanonicalKeys(a.key, b.key));
    sink('{');
    entries.forEach((entry, index) => {
        if (index) sink(',');
        writeJsonString([entry.key], sink); sink(':');
        emitCanonical(entry.value, sink, entry.mode);
    });
    sink('}');
};
