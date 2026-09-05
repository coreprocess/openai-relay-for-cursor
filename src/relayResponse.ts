import type { ServerResponse } from 'node:http';
import { toChatCompletion } from './convertResponse.ts';
import { createResponsesToChatStreamConverter } from './convertStream.ts';
import { sendJson } from './http.ts';
import { logLine, type RequestLog, truncate } from './log.ts';
import type { ResponsesObject, ResponsesStreamEvent } from './responsesTypes.ts';
import { readSseEvents } from './sse.ts';

const parseEventData = (data: string): ResponsesStreamEvent | null => {
    try {
        return JSON.parse(data) as ResponsesStreamEvent;
    } catch {
        return null;
    }
};

const sseHeaders = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' };

/** Streams a Responses SSE body to the client as Chat Completions chunks, logging both sides. */
export const streamConverted = async (upstream: Response, res: ServerResponse, log: RequestLog): Promise<void> => {
    res.writeHead(200, sseHeaders);
    res.flushHeaders();
    const upstreamFrames: string[] = [];
    const clientFrames: string[] = [];
    const convert = createResponsesToChatStreamConverter();
    for await (const event of readSseEvents(upstream.body ?? new ReadableStream())) {
        upstreamFrames.push(`event: ${event.event ?? '-'}\ndata: ${event.data}\n\n`);
        const parsed = parseEventData(event.data);
        for (const frame of parsed ? convert(parsed) : []) {
            clientFrames.push(frame);
            res.write(frame);
        }
    }
    res.end();
    await log.write('3-upstream-response.sse', upstreamFrames.join(''));
    await log.write('4-client-response.sse', clientFrames.join(''));
};

export const sendConvertedJson = async (upstream: Response, res: ServerResponse, log: RequestLog): Promise<void> => {
    const upstreamText = await upstream.text();
    const converted = toChatCompletion(JSON.parse(upstreamText) as ResponsesObject);
    sendJson(res, 200, converted);
    await log.write('3-upstream-response.json', upstreamText);
    await log.write('4-client-response.json', JSON.stringify(converted, null, 2));
};

/** Pipes an upstream response unchanged (used for non-converted paths such as /v1/models). */
export const pipePassthrough = async (upstream: Response, res: ServerResponse, log: RequestLog): Promise<void> => {
    const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
    res.writeHead(upstream.status, { 'content-type': contentType });
    const chunks: Buffer[] = [];
    for await (const chunk of upstream.body ?? new ReadableStream<Uint8Array>()) {
        chunks.push(Buffer.from(chunk));
        res.write(chunk);
    }
    res.end();
    const body = Buffer.concat(chunks).toString('utf8');
    await log.write('3-upstream-response.txt', body);
    await log.write('4-client-response.txt', body);
};

export const relayUpstreamError = async (
    upstream: Response,
    res: ServerResponse,
    log: RequestLog,
    requestId: string,
): Promise<void> => {
    const errorBody = await upstream.text();
    logLine(`${requestId} upstream error body: ${truncate(errorBody)}`);
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    res.end(errorBody);
    await log.write('3-upstream-error.json', errorBody);
};
