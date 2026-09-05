import { chatToResponsesBody, type EffortOptions, resolveEffort } from './chatToResponses.ts';
import type { JsonBody } from './http.ts';

export type UpstreamPlan = {
    path: string;
    body: JsonBody | null;
    /** Human-readable note for the request log, e.g. which translation was applied. */
    note: string;
    convertToChatCompletions: boolean;
};

const passthrough = (path: string, body: JsonBody | null): UpstreamPlan => ({
    path,
    body,
    note: '',
    convertToChatCompletions: false,
});

const withReasoning = (body: JsonBody, effortOptions: EffortOptions): JsonBody => {
    const existing = (body.reasoning as { effort?: unknown } | undefined)?.effort;
    const effort = resolveEffort(existing, effortOptions);
    if (effort === undefined) {
        return body;
    }
    return { ...body, reasoning: { ...(body.reasoning as JsonBody | undefined), effort } };
};

/**
 * Everything Cursor sends to `/chat/completions` is forwarded to `/responses`:
 * - Responses-shaped bodies (`input`, a known Cursor BYOK quirk) only need `stream_options` removed.
 * - Chat-Completions-shaped bodies (`messages`) are translated, because models like gpt-6-astra
 *   only support function tools with reasoning via the Responses API.
 * The response is converted back to Chat Completions format either way.
 */
export const planUpstreamRequest = (path: string, body: JsonBody | null, effortOptions: EffortOptions): UpstreamPlan => {
    const pathWithoutQuery = path.split('?')[0] ?? path;
    if (!pathWithoutQuery.endsWith('/chat/completions') || body === null) {
        return passthrough(path, body);
    }
    const responsesPath = pathWithoutQuery.replace(/\/chat\/completions$/, '/responses');
    if ('input' in body && !('messages' in body)) {
        const { stream_options: _ignored, ...responsesBody } = body;
        return {
            path: responsesPath,
            body: withReasoning(responsesBody, effortOptions),
            note: 'responses-body: stripped stream_options',
            convertToChatCompletions: true,
        };
    }
    if (!('messages' in body)) {
        return passthrough(path, body);
    }
    const { body: translated, droppedKeys } = chatToResponsesBody(body, effortOptions);
    return {
        path: responsesPath,
        body: translated,
        note: `chat->responses${droppedKeys.length > 0 ? ` dropped=[${droppedKeys.join(',')}]` : ''}`,
        convertToChatCompletions: true,
    };
};
