export type ResponsesUsage = {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
};

export type ResponsesOutputItem = {
    id?: string;
    type: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: Array<{ type: string; text?: string }>;
};

export type ResponsesObject = {
    id: string;
    model: string;
    created_at?: number;
    status?: string;
    output?: ResponsesOutputItem[];
    usage?: ResponsesUsage;
    incomplete_details?: { reason?: string };
    error?: { code?: string; message?: string } | null;
};

export type ResponsesStreamEvent = {
    type: string;
    sequence_number?: number;
    response?: ResponsesObject;
    item?: ResponsesOutputItem;
    item_id?: string;
    delta?: string;
    code?: string;
    message?: string;
    param?: string | null;
};

export type ChatUsage = {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details: { cached_tokens: number };
    completion_tokens_details: { reasoning_tokens: number };
};

export const toChatUsage = (usage: ResponsesUsage | undefined): ChatUsage => ({
    prompt_tokens: usage?.input_tokens ?? 0,
    completion_tokens: usage?.output_tokens ?? 0,
    total_tokens: usage?.total_tokens ?? 0,
    prompt_tokens_details: { cached_tokens: usage?.input_tokens_details?.cached_tokens ?? 0 },
    completion_tokens_details: { reasoning_tokens: usage?.output_tokens_details?.reasoning_tokens ?? 0 },
});
