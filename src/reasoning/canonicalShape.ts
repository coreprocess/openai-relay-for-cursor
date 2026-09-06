import type { JsonBody } from '../http.ts';

export type CanonicalMode = 'raw' | 'envelope' | 'calls' | number;
export const isObject = (value: unknown): value is JsonBody =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
export const isOmitted = (value: unknown): boolean =>
    value === undefined || typeof value === 'function' || typeof value === 'symbol';

/** Never collapse an extension-bearing text part, even if translation currently drops it. */
export const isExactTextPart = (value: unknown): value is { type: 'text'; text: string } => {
    if (!isObject(value) || value.type !== 'text' || typeof value.text !== 'string') return false;
    let count = 0;
    for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (++count > 2 || (key !== 'type' && key !== 'text')) return false;
    }
    return count === 2;
};

export class JoinedText {
    readonly content: unknown;
    constructor(content: unknown) { this.content = content; }
    *parts(): Generator<string> {
        if (typeof this.content === 'string') { yield this.content; return; }
        if (!Array.isArray(this.content)) return;
        for (const part of this.content) yield (part as { text: string }).text;
    }
}

const normalizedContent = (content: unknown): unknown => {
    if (content == null || typeof content === 'string') return new JoinedText(content);
    if (!Array.isArray(content)) return content;
    for (const part of content) if (!isExactTextPart(part)) return content;
    return new JoinedText(content);
};

export type CanonicalEntry = { key: string; value: unknown; mode: CanonicalMode };
export class CanonicalObjectView {
    readonly entries: () => Generator<CanonicalEntry>;
    constructor(entries: () => Generator<CanonicalEntry>) { this.entries = entries; }
}
export class CanonicalArrayView {
    readonly values: () => Generator<unknown>;
    readonly itemScratch: (value: unknown) => number;
    constructor(values: () => Generator<unknown>, itemScratch: (value: unknown) => number = () => 0) {
        this.values = values;
        this.itemScratch = itemScratch;
    }
}
/** Lazy projection: no normalized history, joined text, or property-name array is allocated. */
export function* canonicalEntries(value: JsonBody, mode: CanonicalMode): Generator<CanonicalEntry> {
    if (value instanceof CanonicalObjectView) { yield* value.entries(); return; }
    const assistant = mode === 'envelope' && value.role === 'assistant';
    let contentSeen = false;
    for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        const child = value[key];
        if (assistant && key === 'content') {
            contentSeen = true;
            yield { key, value: normalizedContent(child), mode: 'raw' };
            continue;
        }
        if (assistant && key === 'tool_calls' && Array.isArray(child) && child.length === 0) continue;
        if (typeof mode === 'number' && key === 'index' && child === mode) continue;
        if (isOmitted(child)) continue;
        yield { key, value: child, mode: assistant && key === 'tool_calls' ? 'calls' : 'raw' };
    }
    if (assistant && !contentSeen) yield { key: 'content', value: new JoinedText(''), mode: 'raw' };
}

/** JSON.stringify enumerates array-index keys numerically, even after lexicographic insertion. */
const arrayIndex = (key: string): number | null => {
    if (key.length === 0 || key.length > 10) return null;
    const number = Number(key);
    return Number.isInteger(number) && number >= 0 && number < 0xffff_ffff && String(number) === key ? number : null;
};
export const compareCanonicalKeys = (left: string, right: string): number => {
    const a = arrayIndex(left);
    const b = arrayIndex(right);
    if (a !== null || b !== null) return a === null ? 1 : b === null ? -1 : a - b;
    return left < right ? -1 : left > right ? 1 : 0;
};
