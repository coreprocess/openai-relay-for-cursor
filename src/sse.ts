import { RelayFailure } from './failure.ts';

export type SseEvent = { event: string | null; data: string };

const parseEvent = (rawEvent: string): SseEvent | null => {
    const lines = rawEvent.split('\n');
    const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? null;
    const dataLines = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, ''));
    return dataLines.length === 0 ? null : { event: eventName, data: dataLines.join('\n') };
};

export async function* readSseEvents(body: AsyncIterable<Uint8Array>, maxEventBytes = 8 * 1024 * 1024): AsyncGenerator<SseEvent> {
    const decoder = new TextDecoder();
    let buffer = '';
    let pendingCarriageReturn = false;
    const append = (text: string): void => {
        if (!text) return;
        if (pendingCarriageReturn && text.startsWith('\n')) text = text.slice(1);
        pendingCarriageReturn = text.endsWith('\r');
        buffer += text.replace(/\r\n?/g, '\n');
    };
    for await (const chunk of body) {
        // Bound decoding allocation even if a source supplies one very large chunk.
        for (let offset = 0; offset < chunk.length; offset += 16_384) {
            append(decoder.decode(chunk.subarray(offset, offset + 16_384), { stream: true }));
            let index = buffer.indexOf('\n\n');
            while (index !== -1) {
                if (Buffer.byteLength(buffer.slice(0, index)) > maxEventBytes) throw new RelayFailure('upstream_sse_limit');
                const event = parseEvent(buffer.slice(0, index));
                buffer = buffer.slice(index + 2);
                if (event) yield event;
                index = buffer.indexOf('\n\n');
            }
            if (Buffer.byteLength(buffer) > maxEventBytes) throw new RelayFailure('upstream_sse_limit');
        }
    }
    append(decoder.decode());
    const trailing = parseEvent(buffer);
    if (trailing) yield trailing;
}

export const formatSseData = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
