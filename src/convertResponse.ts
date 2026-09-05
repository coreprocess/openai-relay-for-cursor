import { type ResponsesObject, toChatUsage } from './responsesTypes.ts';

/** Non-streaming: Responses API object -> Chat Completions `chat.completion` object. */
export const toChatCompletion = (response: ResponsesObject) => {
    const output = response.output ?? [];
    const content = output
        .filter((item) => item.type === 'message')
        .flatMap((item) => item.content ?? [])
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
                    ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
                },
                finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
            },
        ],
        usage: toChatUsage(response.usage),
    };
};
