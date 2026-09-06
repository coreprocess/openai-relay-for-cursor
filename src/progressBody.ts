/** Observe raw body progress before SSE parsing, including heartbeats and partial frames. */
export async function* bodyChunks(body: ReadableStream<Uint8Array> | null, progress?: () => void): AsyncGenerator<Uint8Array> {
    if (!body) return;
    for await (const chunk of body) {
        progress?.();
        yield chunk;
    }
}

export const readResponseText = async (response: Response, progress?: () => void, maxBytes = 64 * 1024 * 1024): Promise<string> => {
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    for await (const chunk of bodyChunks(response.body, progress)) {
        if (chunk.byteLength > maxBytes - bytes) throw new Error('Upstream response exceeds relay limit');
        bytes += chunk.byteLength;
        text += decoder.decode(chunk, { stream: true });
    }
    return text + decoder.decode();
};
