import type { JsonBody } from './http.ts';

export class InvalidRequestError extends Error {
    constructor(message: string) { super(message); this.name = 'InvalidRequestError'; }
}
const object = (value: unknown): value is JsonBody => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string';
const nonempty = (value: unknown): value is string => string(value) && value.trim().length > 0;
const optional = (value: JsonBody, key: string, valid: (child: unknown) => boolean): boolean =>
    !(key in value) || valid(value[key]);
const arrayOf = (value: unknown, valid: (child: unknown) => boolean): boolean => Array.isArray(value) && value.every(valid);
const requireValid = (valid: boolean, message: string): void => { if (!valid) throw new InvalidRequestError(message); };
const namedFunction = (value: unknown): value is JsonBody => object(value) && nonempty(value.name);
const functionDefinition = (value: unknown): boolean => namedFunction(value) &&
    optional(value, 'description', string) && optional(value, 'parameters', object) &&
    optional(value, 'strict', (strict) => strict === null || typeof strict === 'boolean');
const tool = (value: unknown): boolean => object(value) && nonempty(value.type) &&
    optional(value, 'function', object) &&
    (value.type !== 'function' || functionDefinition('function' in value ? value.function : value));
const toolChoice = (value: unknown): boolean => nonempty(value) || (object(value) && nonempty(value.type) &&
    optional(value, 'function', namedFunction) &&
    (value.type !== 'function' || namedFunction('function' in value ? value.function : value)));
const toolCall = (value: unknown): boolean => {
    if (!object(value) || !nonempty(value.id) || !optional(value, 'type', nonempty) ||
        !optional(value, 'function', object) || !optional(value, 'name', nonempty) ||
        !optional(value, 'arguments', string)) return false;
    const fn = 'function' in value ? value.function : value;
    if (!object(fn) || !optional(fn, 'name', nonempty) || !optional(fn, 'arguments', string)) return false;
    // Keep the mapper's legacy flat calls/default arguments and provider extensions observable.
    return (value.type !== undefined && value.type !== 'function') || namedFunction(fn);
};
const contentPart = (value: unknown): boolean => {
    if (!object(value) || !nonempty(value.type) || !optional(value, 'text', string)) return false;
    if (value.type === 'text') return string(value.text);
    if (value.type !== 'image_url') return true;
    const image = value.image_url;
    return nonempty(image) || (object(image) && nonempty(image.url) && optional(image, 'detail', string));
};
const roles = new Set(['system', 'developer', 'user', 'assistant', 'tool']);

/** Structural guard for the mapper, not a replacement for provider semantic validation.
 * Unknown fields/parts still take the existing observe-only path instead of being discarded. */
export const validateGenerationBody = (body: JsonBody | null): void => {
    if (!object(body)) throw new InvalidRequestError('Expected a JSON object request body');
    requireValid(optional(body, 'model', nonempty), 'model must be a non-empty string');
    requireValid(optional(body, 'store', (value) => typeof value === 'boolean'), 'store must be a boolean');
    requireValid(optional(body, 'include', (value) => arrayOf(value, string)), 'include must be an array of strings');
    // Responses-shaped passthrough does not use the Chat message/tool mapper.
    if (!('messages' in body)) return;
    if (!Array.isArray(body.messages)) throw new InvalidRequestError('messages must be an array');
    for (const message of body.messages) {
        if (!object(message)) throw new InvalidRequestError('Each message must be an object');
        requireValid(string(message.role) && roles.has(message.role), 'Message role must be system, developer, user, assistant, or tool');
        requireValid(string(message.content) || arrayOf(message.content, contentPart) ||
            (message.role === 'assistant' && (message.content === null || !('content' in message))),
            'Message content must be text or an array of content objects; only assistant content may be null or omitted');
        requireValid(optional(message, 'tool_calls', (value) => arrayOf(value, toolCall)),
            'tool_calls must be an array of valid tool-call objects');
        requireValid(optional(message, 'name', string), 'Message name must be a string');
        requireValid(optional(message, 'tool_call_id', nonempty) &&
            (message.role !== 'tool' || nonempty(message.tool_call_id)), 'tool_call_id must be a non-empty string for tool messages');
    }
    requireValid(optional(body, 'tools', (value) => arrayOf(value, tool)), 'tools must be an array of valid tool objects');
    requireValid(optional(body, 'tool_choice', toolChoice), 'tool_choice must be a string or a valid tool-choice object');
};
