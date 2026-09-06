import { chatMessagesToInput } from './chatMessages.ts';
import type { JsonBody } from './http.ts';

type ChatTool = { type?: string; function?: JsonBody; [key: string]: unknown };

/** Priority: alias suffix (explicit user choice in Cursor) > request field > relay default. */
export type EffortOptions = { aliasEffort: string | undefined; defaultEffort: string | undefined };

export const resolveEffort = (requestEffort: unknown, options: EffortOptions): string | undefined =>
    options.aliasEffort ?? (typeof requestEffort === 'string' ? requestEffort : undefined) ?? options.defaultEffort;

/** Chat Completions nests function tools under `function`; Responses uses a flat shape. */
const toFlatTool = (tool: ChatTool): JsonBody => {
    if (tool.type !== 'function' || !tool.function) {
        return tool;
    }
    const { name, description, parameters, strict } = tool.function;
    return { type: 'function', name, description, parameters, strict };
};

const toToolChoice = (toolChoice: unknown): unknown => {
    if (typeof toolChoice !== 'object' || toolChoice === null) {
        return toolChoice;
    }
    const nested = (toolChoice as { function?: { name?: string } }).function;
    return nested ? { type: 'function', name: nested.name } : toolChoice;
};

const directlyMappedKeys = ['model', 'stream', 'temperature', 'top_p', 'parallel_tool_calls', 'metadata', 'store', 'include'] as const;
const handledKeys = new Set<string>([
    ...directlyMappedKeys,
    'messages',
    'tools',
    'tool_choice',
    'reasoning_effort',
    'max_completion_tokens',
    'max_tokens',
    'user',
    'stream_options',
    'n',
]);

export type TranslationResult = { body: JsonBody; droppedKeys: string[] };

/** Translates a Chat Completions request body into a Responses API request body. */
export const chatToResponsesBody = (chat: JsonBody, effortOptions: EffortOptions): TranslationResult => {
    const body: JsonBody = Object.fromEntries(directlyMappedKeys.filter((key) => key in chat).map((key) => [key, chat[key]]));
    body.input = chatMessagesToInput(chat.messages);
    if (Array.isArray(chat.tools)) {
        body.tools = (chat.tools as ChatTool[]).map(toFlatTool);
    }
    if ('tool_choice' in chat) {
        body.tool_choice = toToolChoice(chat.tool_choice);
    }
    const maxTokens = chat.max_completion_tokens ?? chat.max_tokens;
    if (typeof maxTokens === 'number') {
        body.max_output_tokens = maxTokens;
    }
    const effort = resolveEffort(chat.reasoning_effort, effortOptions);
    if (effort !== undefined) {
        body.reasoning = { effort };
    }
    if (typeof chat.user === 'string') {
        body.safety_identifier = chat.user;
    }
    const droppedKeys = Object.keys(chat).filter((key) => !handledKeys.has(key));
    return { body, droppedKeys };
};
