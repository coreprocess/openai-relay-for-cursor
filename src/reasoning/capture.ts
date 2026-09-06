import type { JsonBody } from '../http.ts';
import type { ResponsesObject, ResponsesStreamEvent } from '../responsesTypes.ts';

export type CaptureResult = {
    envelope: unknown | null;
    output: JsonBody[] | null;
    snapshot: string;
    complete: boolean;
    admissible: boolean;
};
type ToolFragments = { id: string[]; name: string[]; arguments: string[]; functionTypeSeen: boolean };
type Visible = { content: string; refusal: string; calls: JsonBody[] };
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const LIMIT = Symbol('capture limit');
const isObject = (value: unknown): value is JsonBody =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const hasOnly = (value: JsonBody, keys: string[]): boolean => Object.keys(value).every((key) => keys.includes(key));
const sameJson = (left: unknown, right: unknown): boolean => {
    if (left === right) return true;
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((item, index) => sameJson(item, right[index]));
    }
    if (!isObject(left) || !isObject(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length &&
        keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
};

/** Deliberately reject number spellings that parsing might change, rather than predict a lossy replay. */
const normalizedArguments = (text: string, parse: (text: string) => unknown): string | null => {
    try {
        const parsed = parse(text);
        for (const token of text.matchAll(/"(?:\\.|[^"\\])*"|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g)) {
            if (token[1] === undefined) continue;
            const number = Number(token[1]);
            if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number)) ||
                JSON.stringify(number) !== token[1]) return null;
        }
        return JSON.stringify(parsed);
    } catch (error) {
        if (error === LIMIT) throw error;
        return null;
    }
};

/**
 * Observe upstream events AND the exact converter frames/object delivered to the client.
 * No hidden output is admissible merely because an upstream completion claims success.
 * The budget conservatively charges retained data and serialization/parse scratch, not only UTF-8 payloads.
 */
export class OutputCapture {
    private readonly maxBytes: number;
    private bytes = 0;
    private exhausted = false;
    private known = true;
    private invalid = false;
    private mode: 'stream' | 'json' | null = null;
    private terminal = false;
    private completed = false;
    private clientDone = false;
    private roleSeen = false;
    private refusalSeen = false;
    private finishReason: unknown = null;
    private snapshot = '';
    private clientModel = '';
    private finalResponse: JsonBody | null = null;
    private readonly done = new Map<number, JsonBody>();
    private readonly added = new Map<number, JsonBody>();
    private readonly text: string[] = [];
    private readonly refusals: string[] = [];
    private readonly tools = new Map<number, ToolFragments>();
    private result: CaptureResult | null = null;

    constructor(maxBytes = DEFAULT_MAX_BYTES) {
        this.maxBytes = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 0;
    }

    private charge(bytes: number): void {
        if (bytes > this.maxBytes - this.bytes) throw LIMIT;
        this.bytes += bytes;
    }

    private string(value: string): string {
        // Covers UTF-16 storage, UTF-8/escaped JSON, parsing and temporary copies.
        this.charge(64 + value.length * 16);
        return value;
    }

    private parseJson(text: string): unknown {
        // Reserve node/container overhead BEFORE JSON.parse allocates it. Quoted strings are
        // opaque here; punctuation outside them bounds the number of potential JSON nodes.
        let quoted = false;
        let escaped = false;
        let depth = 0;
        this.charge(128);
        for (const character of text) {
            if (quoted) {
                if (escaped) escaped = false;
                else if (character === '\\') escaped = true;
                else if (character === '"') quoted = false;
                continue;
            }
            if (character === '"') quoted = true;
            if (character === '[' || character === '{') {
                if (++depth > 64) throw LIMIT;
            } else if (character === ']' || character === '}') depth--;
            if ('[{,:'.includes(character)) this.charge(128);
        }
        return JSON.parse(text) as unknown;
    }

    private copy(value: unknown, depth = 0, ancestors = new Set<object>()): unknown {
        this.charge(128);
        if (depth > 64) throw LIMIT;
        if (typeof value === 'string') return this.string(value);
        if (value === null || typeof value === 'boolean') return value;
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value !== 'object' || !value || ancestors.has(value)) throw LIMIT;
        const prototype = Object.getPrototypeOf(value);
        if (Array.isArray(value) && value.length > Math.floor((this.maxBytes - this.bytes) / 128)) throw LIMIT;
        if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw LIMIT;
        ancestors.add(value);
        const result: unknown[] | JsonBody = Array.isArray(value) ? [] : Object.create(null) as JsonBody;
        for (const key in value) {
            if (!Object.hasOwn(value, key)) continue;
            if (Array.isArray(result) && key !== String(result.length)) throw LIMIT;
            this.string(key);
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !('value' in descriptor)) throw LIMIT;
            if (descriptor.value === undefined && !Array.isArray(value)) continue;
            const child = this.copy(descriptor.value === undefined ? null : descriptor.value, depth + 1, ancestors);
            if (Array.isArray(result)) result.push(child);
            else result[key] = child;
        }
        if (Array.isArray(value) && (result as unknown[]).length !== value.length) throw LIMIT;
        ancestors.delete(value);
        return result;
    }

    private observe(action: () => void): void {
        if (this.exhausted || this.result) return;
        try {
            action();
        } catch {
            // Release everything, including encrypted strings. An unknown envelope tells the caller to poison.
            this.exhausted = true;
            this.known = false;
            this.invalid = true;
            this.finalResponse = null;
            this.done.clear();
            this.added.clear();
            this.tools.clear();
            this.text.length = 0;
            this.refusals.length = 0;
            this.snapshot = '';
            this.clientModel = '';
        }
    }

    addEvent(event: ResponsesStreamEvent): void {
        this.observe(() => {
            if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
                if (this.terminal) this.invalid = true;
                const index = event.output_index;
                if (!Number.isSafeInteger(index) || index === undefined || index < 0 || !isObject(event.item)) {
                    this.invalid = true;
                    return;
                }
                const item = this.copy(event.item) as JsonBody;
                const items = event.type.endsWith('.done') ? this.done : this.added;
                if (items.has(index) && !sameJson(items.get(index), item)) this.invalid = true;
                items.set(index, item);
                return;
            }
            if (['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(event.type)) {
                if (this.terminal) this.invalid = true;
                this.terminal = true;
                this.completed = event.type === 'response.completed';
                if (!this.completed) this.invalid = true;
                if (event.response) this.setResponse(event.response);
                else this.invalid = true;
                return;
            }
            if (this.terminal && (event.type.endsWith('.delta') || event.type.endsWith('.done'))) this.invalid = true;
        });
    }

    private setResponse(response: ResponsesObject): void {
        const copy = this.copy(response) as JsonBody;
        if (this.finalResponse && !sameJson(this.finalResponse, copy)) this.invalid = true;
        this.finalResponse = copy;
        if (typeof copy.model === 'string') this.snapshot = copy.model;
        if (copy.status !== 'completed' || copy.error != null || copy.incomplete_details != null) this.invalid = true;
    }

    addFrame(frame: string): void {
        this.observe(() => {
            if (this.mode === 'json') this.known = false;
            this.mode = 'stream';
            if (!this.known) return;
            this.string(frame);
            // One call may contain several complete SSE frames; partial/unknown frames fail closed.
            if (!frame.replace(/\r\n/g, '\n').endsWith('\n\n')) {
                this.known = false;
                return;
            }
            for (const block of frame.replace(/\r\n/g, '\n').split('\n\n')) {
                if (!block.trim()) continue;
                const data: string[] = [];
                for (const line of block.split('\n')) {
                    if (line.startsWith(':') || line === '') continue;
                    if (!line.startsWith('data:')) {
                        this.known = false;
                        return;
                    }
                    data.push(line.slice(5).replace(/^ /, ''));
                }
                if (data.length === 0) continue;
                const payload = data.join('\n');
                if (this.clientDone) {
                    this.known = false;
                    return;
                }
                if (payload === '[DONE]') {
                    this.clientDone = true;
                    if (this.finishReason === null) this.invalid = true;
                    continue;
                }
                this.consumeChat(this.copy(this.parseJson(payload)), true);
            }
        });
    }

    addJson(chat: unknown): void {
        this.observe(() => {
            if (this.mode !== null) this.known = false;
            this.mode = 'json';
            if (!this.known) return;
            this.consumeChat(this.copy(chat), false);
            this.clientDone = true;
        });
    }

    private consumeChat(chat: unknown, streaming: boolean): void {
        if (!isObject(chat) || chat.error != null || !Array.isArray(chat.choices)) {
            this.known = false;
            return;
        }
        if (typeof chat.model !== 'string' || !chat.model || (this.clientModel && this.clientModel !== chat.model)) {
            this.invalid = true;
        } else this.clientModel = this.string(chat.model);
        if (chat.choices.length === 0 && streaming) return;
        if (chat.choices.length !== 1) {
            this.known = false;
            return;
        }
        const choice = chat.choices[0];
        if (!isObject(choice) || choice.index !== 0 || this.finishReason !== null) {
            this.known = false;
            return;
        }
        const message = streaming ? choice.delta : choice.message;
        if (!isObject(message) || !hasOnly(message, ['role', 'content', 'refusal', 'tool_calls']) ||
            (message.role !== undefined && message.role !== 'assistant') || (!streaming && message.role !== 'assistant')) {
            this.known = false;
            return;
        }
        if (message.role === 'assistant') this.roleSeen = true;
        if (typeof message.refusal === 'string') this.refusalSeen = true;
        for (const [key, fragments] of [['content', this.text], ['refusal', this.refusals]] as const) {
            const value = message[key];
            if (value === null || value === undefined) continue;
            if (typeof value !== 'string') {
                this.known = false;
                return;
            }
            fragments.push(this.string(value));
        }
        if (message.tool_calls !== undefined) {
            if (!Array.isArray(message.tool_calls)) {
                this.known = false;
                return;
            }
            for (const [position, tool] of message.tool_calls.entries()) this.consumeTool(tool, streaming, position);
        }
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
            this.finishReason = choice.finish_reason;
            if (!['stop', 'tool_calls'].includes(String(this.finishReason))) this.invalid = true;
        } else if (!streaming) this.invalid = true;
    }

    private consumeTool(value: unknown, streaming: boolean, position: number): void {
        if (!isObject(value) || !hasOnly(value, ['index', 'id', 'type', 'function']) ||
            (value.type !== undefined && value.type !== 'function')) {
            this.known = false;
            return;
        }
        const index = streaming ? value.index : (value.index ?? position);
        if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || (!streaming && index !== position) ||
            !isObject(value.function) || !hasOnly(value.function, ['name', 'arguments'])) {
            this.known = false;
            return;
        }
        if (!this.tools.has(index)) {
            this.charge(256);
            this.tools.set(index, { id: [], name: [], arguments: [], functionTypeSeen: false });
        }
        const tool = this.tools.get(index)!;
        if (value.type === 'function') tool.functionTypeSeen = true;
        for (const [key, valuePart] of [['id', value.id], ['name', value.function.name], ['arguments', value.function.arguments]] as const) {
            if (valuePart === undefined) continue;
            if (typeof valuePart !== 'string') {
                this.known = false;
                return;
            }
            tool[key].push(this.string(valuePart));
        }
    }

    private join(fragments: string[]): string {
        this.charge(64 + fragments.reduce((sum, value) => sum + value.length * 16, 0));
        return fragments.join('');
    }

    private visible(): Visible | null {
        if (!this.known || !this.roleSeen) return null;
        const calls: JsonBody[] = [];
        const ids = new Set<string>();
        for (let index = 0; index < this.tools.size; index++) {
            const tool = this.tools.get(index);
            if (!tool || !tool.functionTypeSeen) return null;
            const id = this.join(tool.id);
            const name = this.join(tool.name);
            const args = this.join(tool.arguments);
            if (!id || !name || ids.has(id)) return null;
            ids.add(id);
            calls.push({ id, type: 'function', function: { name, arguments: args } });
        }
        return { content: this.join(this.text), refusal: this.join(this.refusals), calls };
    }

    private output(): JsonBody[] | null {
        const final = this.finalResponse?.output;
        if (final !== undefined) {
            if (!Array.isArray(final) || !final.every(isObject)) return null;
            return final;
        }
        if (this.done.size === 0) return null;
        const output: JsonBody[] = [];
        for (let index = 0; index < this.done.size; index++) {
            const item = this.done.get(index);
            if (!item) return null;
            output.push(item);
        }
        return output;
    }

    private reconcile(output: JsonBody[]): boolean {
        for (const [index, item] of this.done) {
            const final = output[index];
            if (sameJson(final, item)) continue;
            // Live Responses streams can re-encrypt an otherwise identical reasoning item
            // between item.done and response.completed. The completed output is authoritative.
            if (!final || final.type !== 'reasoning' || item.type !== 'reasoning' || !nonempty(final.id) ||
                final.id !== item.id || !nonempty(final.encrypted_content) || !nonempty(item.encrypted_content)) return false;
            const finalKeys = Object.keys(final).filter((key) => key !== 'encrypted_content');
            const itemKeys = Object.keys(item).filter((key) => key !== 'encrypted_content');
            if (finalKeys.length !== itemKeys.length || finalKeys.some((key) => !Object.hasOwn(item, key) || !sameJson(final[key], item[key]))) return false;
        }
        for (const [index, item] of this.added) {
            const final = output[index];
            if (!final || ['type', 'id', 'call_id', 'name'].some((key) => item[key] !== undefined && item[key] !== final[key])) return false;
        }
        return true;
    }

    private project(output: JsonBody[]): { visible: Visible; reasoning: boolean } | null {
        const text: string[] = [];
        const calls: JsonBody[] = [];
        const ids = new Set<string>();
        let reasoning = false;
        for (const item of output) {
            if (item.status !== undefined && item.status !== 'completed') return null;
            if (item.id !== undefined && !nonempty(item.id)) return null;
            if (typeof item.id === 'string') {
                if (ids.has(item.id)) return null;
                ids.add(item.id);
            }
            if (item.type === 'reasoning') {
                if (!hasOnly(item, ['type', 'id', 'status', 'summary', 'content', 'encrypted_content']) ||
                    (item.encrypted_content !== undefined && item.encrypted_content !== null && typeof item.encrypted_content !== 'string')) return null;
                if (item.summary !== undefined && (!Array.isArray(item.summary) || !item.summary.every((part) =>
                    isObject(part) && hasOnly(part, ['type', 'text']) && part.type === 'summary_text' && typeof part.text === 'string'))) return null;
                if (item.content !== undefined && (!Array.isArray(item.content) || !item.content.every((part) =>
                    isObject(part) && hasOnly(part, ['type', 'text']) && part.type === 'reasoning_text' && typeof part.text === 'string'))) return null;
                reasoning ||= typeof item.encrypted_content === 'string' && item.encrypted_content.trim().length > 0;
            } else if (item.type === 'message') {
                if (!hasOnly(item, ['type', 'id', 'status', 'role', 'content', 'phase']) || item.role !== 'assistant' ||
                    (item.phase !== undefined && !['commentary', 'final_answer'].includes(String(item.phase))) || !Array.isArray(item.content)) return null;
                for (const part of item.content) {
                    if (!isObject(part) || !hasOnly(part, ['type', 'text', 'annotations', 'logprobs']) ||
                        part.type !== 'output_text' || typeof part.text !== 'string') return null;
                    text.push(part.text);
                }
            } else if (item.type === 'function_call') {
                if (!hasOnly(item, ['type', 'id', 'status', 'call_id', 'name', 'arguments']) || !nonempty(item.id) ||
                    !nonempty(item.call_id) || !nonempty(item.name) || typeof item.arguments !== 'string') return null;
                calls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
            } else return null;
        }
        this.charge(256 * calls.length);
        return { visible: { content: this.join(text), refusal: '', calls }, reasoning };
    }

    finish(response?: ResponsesObject): CaptureResult {
        if (this.result) return this.result;
        let result: CaptureResult | null = null;
        this.observe(() => {
            if (response) {
                this.setResponse(response);
                if (this.mode === 'json') this.completed = response.status === 'completed';
            }
            const output = this.output();
            const actual = this.visible();
            const projection = output ? this.project(output) : null;
            let envelope: JsonBody | null = null;
            if (actual && (actual.content || actual.refusal || actual.calls.length)) {
                const calls: JsonBody[] = [];
                let predictable = true;
                for (const call of actual.calls) {
                    const fn = call.function as JsonBody;
                    this.string(fn.arguments as string);
                    const args = normalizedArguments(fn.arguments as string, (text) => this.parseJson(text));
                    if (args === null) { predictable = false; break; }
                    calls.push({ ...call, function: { name: fn.name, arguments: this.string(args) } });
                }
                if (predictable) envelope = {
                    role: 'assistant', content: actual.content || null,
                    ...(actual.refusal ? { refusal: actual.refusal } : {}),
                    ...(calls.length ? { tool_calls: calls } : {}),
                };
            }
            // Completion is a transport/terminal fact, not admission. Even unsupported/refusal/no-reasoning
            // generations must be observed by the parent so they can tombstone/poison older cache positions.
            const complete = !this.invalid && this.completed && this.clientDone && this.roleSeen &&
                this.finishReason === (actual?.calls.length ? 'tool_calls' : 'stop') &&
                !!this.snapshot && this.snapshot === this.clientModel && !!output && this.reconcile(output);
            const admissible = complete && !this.refusalSeen && !!envelope && !!projection?.reasoning &&
                sameJson(actual, projection.visible);
            result = { envelope, output, snapshot: this.snapshot, complete, admissible };
        });
        this.result = result ?? { envelope: null, output: null, snapshot: '', complete: false, admissible: false };
        return this.result;
    }
}
