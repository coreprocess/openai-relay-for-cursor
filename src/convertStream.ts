import { type ResponsesStreamEvent, toChatUsage } from './responsesTypes.ts';
import { formatSseData } from './sse.ts';

type Delta = Record<string, unknown>;
type FinishReason = 'stop' | 'tool_calls' | 'length' | null;

/**
 * Stateful converter: Responses API stream events -> Chat Completions `chat.completion.chunk` SSE frames.
 * Returns one or more ready-to-write SSE strings per input event (possibly none).
 */
export const createResponsesToChatStreamConverter = () => {
    const state = {
        id: 'chatcmpl-relay',
        model: '',
        created: Math.floor(Date.now() / 1000),
        toolCallIndexByItemId: new Map<string, number>(),
        sawToolCall: false,
    };

    const chunk = (delta: Delta, finishReason: FinishReason = null, extra: Record<string, unknown> = {}): string =>
        formatSseData({
            id: state.id,
            object: 'chat.completion.chunk',
            created: state.created,
            model: state.model,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
            ...extra,
        });

    const finish = (finishReason: FinishReason, event: ResponsesStreamEvent): string[] => [
        chunk({}, finishReason),
        formatSseData({
            id: state.id,
            object: 'chat.completion.chunk',
            created: state.created,
            model: state.model,
            choices: [],
            usage: toChatUsage(event.response?.usage),
        }),
        'data: [DONE]\n\n',
    ];

    return (event: ResponsesStreamEvent): string[] => {
        switch (event.type) {
            case 'response.created':
                state.id = event.response?.id ?? state.id;
                state.model = event.response?.model ?? state.model;
                return [chunk({ role: 'assistant', content: '' })];
            case 'response.output_text.delta':
                return [chunk({ content: event.delta ?? '' })];
            case 'response.refusal.delta':
                return [chunk({ refusal: event.delta ?? '' })];
            case 'response.output_item.added': {
                if (event.item?.type !== 'function_call' || !event.item.id) {
                    return [];
                }
                const index = state.toolCallIndexByItemId.size;
                state.toolCallIndexByItemId.set(event.item.id, index);
                state.sawToolCall = true;
                const toolCall = { index, id: event.item.call_id, type: 'function', function: { name: event.item.name, arguments: '' } };
                return [chunk({ tool_calls: [toolCall] })];
            }
            case 'response.function_call_arguments.delta': {
                const index = state.toolCallIndexByItemId.get(event.item_id ?? '');
                if (index === undefined) {
                    return [];
                }
                return [chunk({ tool_calls: [{ index, function: { arguments: event.delta ?? '' } }] })];
            }
            case 'response.completed':
                return finish(state.sawToolCall ? 'tool_calls' : 'stop', event);
            case 'response.incomplete':
                return finish(event.response?.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'stop', event);
            case 'response.failed':
                return [formatSseData({ error: event.response?.error ?? { message: 'response failed' } }), 'data: [DONE]\n\n'];
            case 'error':
                return [formatSseData({ error: { code: event.code, message: event.message, param: event.param } }), 'data: [DONE]\n\n'];
            default:
                return [];
        }
    };
};
