import type { JsonBody } from '../http.ts';
import { isObject } from './canonicalShape.ts';

const only = (value: JsonBody, fields: readonly string[]): boolean => {
    for (const key in value) if (Object.hasOwn(value, key) && !fields.includes(key)) return false;
    return true;
};
const optional = (value: JsonBody, key: string, validate: (child: unknown) => boolean): boolean =>
    value[key] === undefined || validate(value[key]);
const string = (value: unknown): value is string => typeof value === 'string';
const boolean = (value: unknown): boolean => typeof value === 'boolean';
const oneOf = (...values: unknown[]) => (value: unknown): boolean => values.includes(value);
const tool = (value: unknown): boolean => isObject(value) &&
    only(value, ['type', 'name', 'description', 'parameters', 'strict']) && value.type === 'function' &&
    string(value.name) && value.name.length > 0 && optional(value, 'description', string) &&
    optional(value, 'parameters', isObject) && optional(value, 'strict', oneOf(true, false, null));
const toolChoice = (value: unknown): boolean => oneOf('none', 'auto', 'required')(value) ||
    (isObject(value) && only(value, ['type', 'name']) && value.type === 'function' && string(value.name) && value.name.length > 0);
const reasoning = (value: unknown): boolean => isObject(value) && only(value, ['effort', 'summary', 'generate_summary', 'context']) &&
    optional(value, 'effort', oneOf('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')) &&
    optional(value, 'summary', oneOf(null, 'auto', 'concise', 'detailed')) &&
    optional(value, 'generate_summary', oneOf(null, 'auto', 'concise', 'detailed')) &&
    optional(value, 'context', oneOf('all_turns', 'last_turn'));
const format = (value: unknown): boolean => {
    if (!isObject(value)) return false;
    if (value.type === 'text' || value.type === 'json_object') return only(value, ['type']);
    return value.type === 'json_schema' && only(value, ['type', 'name', 'description', 'schema', 'strict']) &&
        string(value.name) && isObject(value.schema) && optional(value, 'description', string) &&
        optional(value, 'strict', oneOf(true, false, null));
};
const text = (value: unknown): boolean => isObject(value) && only(value, ['format', 'verbosity']) &&
    optional(value, 'format', format) && optional(value, 'verbosity', oneOf('low', 'medium', 'high'));
const includes = new Set([
    'reasoning.encrypted_content', 'message.output_text.logprobs', 'message.input_image.image_url',
    'file_search_call.results', 'web_search_call.action.sources', 'computer_call_output.output.image_url',
    'code_interpreter_call.outputs',
]);
/** Schemas and metadata are opaque configuration data; their complete nested values are scope-hashed. */
export const isEligibleConfiguration = (body: JsonBody): boolean => {
    if (!optional(body, 'tools', (value) => Array.isArray(value) && value.every(tool))) return false;
    if (!optional(body, 'tool_choice', toolChoice) || !optional(body, 'reasoning', reasoning) || !optional(body, 'text', text)) return false;
    if (!optional(body, 'include', (value) => Array.isArray(value) && value.every((item) => string(item) && includes.has(item)))) return false;
    for (const field of ['safety_identifier', 'user', 'instructions', 'prompt_cache_key', 'prompt_cache_retention']) {
        if (!optional(body, field, string)) return false;
    }
    for (const field of ['parallel_tool_calls', 'store', 'stream']) if (!optional(body, field, boolean)) return false;
    if (!optional(body, 'temperature', (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2)) return false;
    if (!optional(body, 'top_p', (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)) return false;
    if (!optional(body, 'max_output_tokens', (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0)) return false;
    if (!optional(body, 'truncation', oneOf('auto', 'disabled'))) return false;
    if (!optional(body, 'service_tier', oneOf('auto', 'default', 'flex', 'scale', 'priority'))) return false;
    return optional(body, 'metadata', (value) => value === null || isObject(value));
};
