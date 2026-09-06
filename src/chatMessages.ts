import type { JsonBody } from './http.ts';

type ContentPart = { type?: string; text?: string; image_url?: string | { url?: string; detail?: string } };
type ChatToolCall = { id?: string; name?: string; arguments?: string; function?: { name?: string; arguments?: string } };
type ChatMessage = {
    role?: string;
    content?: string | ContentPart[] | null;
    tool_calls?: ChatToolCall[];
    tool_call_id?: string;
};

const contentToText = (content: ChatMessage['content']): string => {
    if (typeof content === 'string') {
        return content;
    }
    return (content ?? []).map((part) => part.text ?? '').join('');
};

const toInputPart = (part: ContentPart): JsonBody | null => {
    if (part.type === 'text') {
        return { type: 'input_text', text: part.text ?? '' };
    }
    if (part.type === 'image_url') {
        const image = typeof part.image_url === 'string' ? { url: part.image_url } : part.image_url;
        return { type: 'input_image', image_url: image?.url, detail: image?.detail ?? 'auto' };
    }
    return null;
};

/** Strings stay strings; part arrays become Responses input parts (used for user and tool content). */
const toInputContent = (content: ChatMessage['content']): string | JsonBody[] => {
    if (typeof content === 'string' || content === null || content === undefined) {
        return content ?? '';
    }
    return content.map(toInputPart).filter((part): part is JsonBody => part !== null);
};

const toFunctionCall = (toolCall: ChatToolCall): JsonBody => ({
    type: 'function_call',
    call_id: toolCall.id,
    name: toolCall.function?.name ?? toolCall.name,
    arguments: toolCall.function?.arguments ?? toolCall.arguments ?? '{}',
});

/** Translates one Chat Completions message into zero or more Responses API input items. */
export const chatMessageToInput = (message: ChatMessage): JsonBody[] => {
    switch (message.role) {
        case 'tool':
            return [{ type: 'function_call_output', call_id: message.tool_call_id, output: toInputContent(message.content) }];
        case 'assistant': {
            const text = contentToText(message.content);
            const textItems: JsonBody[] = text.length > 0 ? [{ role: 'assistant', content: text }] : [];
            return [...textItems, ...(message.tool_calls ?? []).map(toFunctionCall)];
        }
        case 'user':
            return [{ role: 'user', content: toInputContent(message.content) }];
        default:
            return [{ role: message.role ?? 'system', content: contentToText(message.content) }];
    }
};

export const chatMessagesToInput = (messages: unknown): JsonBody[] =>
    Array.isArray(messages) ? (messages as ChatMessage[]).flatMap(chatMessageToInput) : [];
