import { type ResponsesObject, toChatUsage } from './responsesTypes.ts';

/** Non-streaming: Responses API object -> Chat Completions `chat.completion` object. */
export const toChatCompletion = (response: ResponsesObject) => {
    const output = response.output ?? [];
    const parts = output.filter((item) => item.type === 'message').flatMap((item) => item.content ?? []);
    const refusals = parts.filter((part) => part.type === 'refusal' && typeof part.refusal === 'string');
    const content = parts
        .filter((part) => part.type === 'output_text')
        .map((part) => part.text ?? '')
        .join('');
    const toolCalls = output
        .filter((item) => item.type === 'function_call')
        .map((item, index) => ({
            index,
            id: item.call_id,
            type: 'function',
            function: { name: item.name, arguments: item.arguments ?? '' },
        }));
    const hasToolCalls = toolCalls.length > 0;
    return {
        id: response.id,
        object: 'chat.completion',
        created: response.created_at ?? Math.floor(Date.now() / 1000),
        model: response.model,
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content: content.length > 0 ? content : null,
                    ...(refusals.length > 0 ? { refusal: refusals.map((part) => part.refusal).join('') } : {}),
                    ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
                },
                finish_reason: response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens'
                    ? 'length' : hasToolCalls ? 'tool_calls' : 'stop',
            },
        ],
        usage: toChatUsage(response.usage),
    };
};
