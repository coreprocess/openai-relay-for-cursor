import type { JsonBody } from '../http.ts';
import { isExactTextPart, isObject } from './canonicalShape.ts';
import { isEligibleConfiguration } from './eligibilityConfig.ts';

export const CHAT_FIELDS = new Set([
    'messages', 'model', 'stream', 'stream_options', 'n', 'tools', 'tool_choice', 'reasoning_effort',
    'max_completion_tokens', 'max_tokens', 'user', 'temperature', 'top_p', 'parallel_tool_calls', 'metadata',
    'instructions', 'reasoning', 'max_output_tokens', 'text', 'response_format', 'safety_identifier',
    'store', 'include', 'service_tier', 'truncation', 'prompt_cache_key', 'prompt_cache_retention',
]);
export const OUTBOUND_FIELDS = new Set([
    'input', 'model', 'stream', 'tools', 'tool_choice', 'reasoning', 'max_output_tokens', 'safety_identifier',
    'temperature', 'top_p', 'parallel_tool_calls', 'metadata', 'instructions', 'text', 'store', 'include',
    'service_tier', 'truncation', 'prompt_cache_key', 'prompt_cache_retention', 'user',
]);
const only = (value: JsonBody, fields: readonly string[]): boolean => {
    for (const key in value) if (Object.hasOwn(value, key) && !fields.includes(key)) return false;
    return true;
};
const dataImage = (value: unknown): boolean => {
    if (!isObject(value) || value.type !== 'image_url' || !only(value, ['type', 'image_url'])) return false;
    const image = value.image_url;
    if (typeof image === 'string') return /^data:image\/[a-z0-9.+-]+[;,]/i.test(image);
    return isObject(image) && only(image, ['url', 'detail']) && typeof image.url === 'string' &&
        /^data:image\/[a-z0-9.+-]+[;,]/i.test(image.url) &&
        (image.detail === undefined || ['auto', 'low', 'high'].includes(image.detail as string));
};
const content = (value: unknown, images = false): boolean =>
    typeof value === 'string' || (Array.isArray(value) && value.every((part) => isExactTextPart(part) || (images && dataImage(part))));
const toolCall = (value: unknown, index: number): boolean => {
    if (!isObject(value) || !only(value, ['id', 'type', 'function', 'index'])) return false;
    if (typeof value.id !== 'string' || !value.id || value.type !== 'function') return false;
    if (Object.hasOwn(value, 'index') && value.index !== index) return false;
    const fn = value.function;
    return isObject(fn) && only(fn, ['name', 'arguments']) && typeof fn.name === 'string' && fn.name.length > 0 &&
        typeof fn.arguments === 'string';
};
export const isEligibleMessage = (value: unknown): boolean => {
    if (!isObject(value)) return false;
    switch (value.role) {
        case 'system': case 'developer':
            return only(value, ['role', 'content']) && content(value.content);
        case 'user': return only(value, ['role', 'content']) && content(value.content, true);
        case 'assistant':
            return only(value, ['role', 'content', 'tool_calls']) &&
                (value.content == null || content(value.content)) &&
                (!Object.hasOwn(value, 'tool_calls') || (Array.isArray(value.tool_calls) && value.tool_calls.every(toolCall)));
        case 'tool':
            return only(value, ['role', 'tool_call_id', 'content', 'name']) && typeof value.tool_call_id === 'string' &&
                value.tool_call_id.length > 0 && content(value.content) &&
                (!Object.hasOwn(value, 'name') || typeof value.name === 'string');
        default: return false;
    }
};
const classified = (value: JsonBody, fields: Set<string>): boolean => {
    for (const key in value) if (Object.hasOwn(value, key) && !fields.has(key)) return false;
    return true;
};
/** Run after bounded preparation; unknown nested history remains hashed, never silently discarded. */
export const isReplayEligible = (chat: JsonBody, outbound: JsonBody): boolean => {
    if (!Array.isArray(chat.messages) || !classified(chat, CHAT_FIELDS) || !classified(outbound, OUTBOUND_FIELDS)) return false;
    if (typeof outbound.model !== 'string' || !outbound.model) return false;
    if ('previous_response_id' in chat || 'conversation' in chat || 'input' in chat) return false;
    if ('previous_response_id' in outbound || 'conversation' in outbound) return false;
    return isEligibleConfiguration(outbound) && chat.messages.every(isEligibleMessage);
};
