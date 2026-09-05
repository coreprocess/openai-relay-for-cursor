export type SseEvent = { event: string | null; data: string };

const parseEvent = (rawEvent: string): SseEvent | null => {
    const lines = rawEvent.split('\n');
    const eventName = lines.find((line) => line.startsWith('event:'))?.slice('event:'.length).trim() ?? null;
    const dataLines = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice('data:'.length).trim());
    if (dataLines.length === 0) {
        return null;
    }
    return { event: eventName, data: dataLines.join('\n') };
};

export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
        let separatorIndex = buffer.indexOf('\n\n');
        while (separatorIndex !== -1) {
            const event = parseEvent(buffer.slice(0, separatorIndex));
            buffer = buffer.slice(separatorIndex + 2);
            if (event) {
                yield event;
            }
            separatorIndex = buffer.indexOf('\n\n');
        }
    }
    const trailing = parseEvent(buffer);
    if (trailing) {
        yield trailing;
    }
}

export const formatSseData = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
