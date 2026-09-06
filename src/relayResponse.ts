import type { ServerResponse } from 'node:http';
import { writeClientFrame } from './clientWrite.ts';
import { toChatCompletion } from './convertResponse.ts';
import { createResponsesToChatStreamConverter } from './convertStream.ts';
import { sendJson } from './http.ts';
import { createLogBuffer, logLine, type RequestLog } from './log.ts';
import type { RequestTransport } from './transport.ts';
import { bodyChunks, readResponseText } from './progressBody.ts';
import type { ReplaySession } from './reasoning/session.ts';
import type { ResponsesObject, ResponsesStreamEvent } from './responsesTypes.ts';
import { readSseEvents } from './sse.ts';
import { createSseWriter } from './sseWriter.ts';
import { RelayFailure } from './failure.ts';

const parseEventData = (data: string): ResponsesStreamEvent | null => {
    try { return JSON.parse(data) as ResponsesStreamEvent; } catch { return null; }
};
const sseHeaders = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' };

export const streamConverted = async (
    upstream: Response, res: ServerResponse, log: RequestLog, session?: ReplaySession | null, transport?: RequestTransport,
): Promise<void> => {
    res.writeHead(200, sseHeaders);
    res.flushHeaders();
    const upstreamFrames = createLogBuffer(log.enabled);
    const clientFrames = createLogBuffer(log.enabled);
    const convert = createResponsesToChatStreamConverter();
    const writer = createSseWriter(res, {
        intervalMs: transport?.limits.sseKeepaliveMs, writeTimeoutMs: transport?.limits.deliveryTimeoutMs,
        onKeepalive: (frame) => { if (log.enabled) clientFrames.push(frame); transport?.keepalive(); },
        onError: (error) => { transport?.abort(error); session?.abort(error); res.destroy(); },
    });
    let terminal = false;
    try {
        for await (const event of readSseEvents(bodyChunks(upstream.body, () => {
            transport?.progress(); session?.progress();
        }), transport?.limits.maxSseEventBytes)) {
            if (log.enabled) upstreamFrames.push(`event: ${event.event ?? '-'}\ndata: ${event.data}\n\n`);
            if (terminal) throw new RelayFailure('upstream_protocol_error');
            const parsed = parseEventData(event.data);
            if (!parsed) throw new RelayFailure('upstream_protocol_error');
            session?.event(parsed);
            const frames = convert(parsed);
            if (['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(parsed.type)) writer.stop();
            if (parsed.type === 'response.completed') {
                // Terminal frames carry no new visible content. Validate their exact queued bytes
                // before publication; delivery remains pending until those bytes finish locally.
                for (const frame of frames) session?.frame(frame);
                session?.complete(parsed.response);
                terminal = true;
            } else if (['response.incomplete', 'response.failed', 'error'].includes(parsed.type)) {
                session?.finishWithoutCapture();
                terminal = true;
            }
            if (terminal) transport?.beginDelivery();
            for (const frame of frames) {
                if (log.enabled) clientFrames.push(frame);
                // Recording and write submission are synchronous; a write failure poisons in finally.
                if (parsed.type !== 'response.completed') session?.frame(frame);
                transport?.clientFrame(['response.output_text.delta', 'response.refusal.delta',
                    'response.function_call_arguments.delta', 'response.output_item.added'].includes(parsed.type));
                await writer.write(frame);
            }
            if (terminal) break;
        }
        if (!terminal) throw new RelayFailure('upstream_stream_incomplete');
        session?.ensureCompleted();
        res.end();
    } catch (error) {
        writer.stop();
        session?.abort(error);
        throw error;
    } finally {
        writer.stop();
        session?.ensureCompleted();
        await log.write('3-upstream-response.sse', upstreamFrames.text());
        await log.write('4-client-response.sse', clientFrames.text());
    }
};

export const sendConvertedJson = async (
    upstream: Response, res: ServerResponse, log: RequestLog, session?: ReplaySession | null, transport?: RequestTransport,
): Promise<void> => {
    const upstreamText = await readResponseText(upstream, () => { transport?.progress(); session?.progress(); }, transport?.limits.maxResponseBytes);
    const response = JSON.parse(upstreamText) as ResponsesObject;
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('Invalid upstream response');
    if (response.error || response.status === 'failed') {
        session?.finishWithoutCapture(); transport?.beginDelivery();
        sendJson(res, 502, { error: response.error ?? { message: 'Upstream response failed', type: 'upstream_error' } });
        await log.write('3-upstream-response.json', upstreamText);
        return;
    }
    if (response.status !== undefined && !['completed', 'incomplete'].includes(response.status)) {
        throw new Error('Upstream JSON response is not terminal');
    }
    const converted = toChatCompletion(response);
    session?.json(converted);
    session?.complete(response); transport?.beginDelivery();
    sendJson(res, 200, converted);
    await log.write('3-upstream-response.json', upstreamText);
    await log.write('4-client-response.json', JSON.stringify(converted, null, 2));
};

export const pipePassthrough = async (upstream: Response, res: ServerResponse, log: RequestLog, transport?: RequestTransport): Promise<void> => {
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream' });
    const capture = createLogBuffer(log.enabled);
    for await (const chunk of bodyChunks(upstream.body, transport?.progress)) {
        capture.push(chunk);
        await writeClientFrame(res, chunk, transport?.limits.deliveryTimeoutMs);
    }
    transport?.beginDelivery(); res.end();
    await log.write('3-upstream-response.txt', capture.text());
    await log.write('4-client-response.txt', capture.text());
};

export const relayUpstreamError = async (upstream: Response, res: ServerResponse, log: RequestLog, requestId: string,
    transport?: RequestTransport, session?: ReplaySession | null): Promise<void> => {
    const errorBody = await readResponseText(upstream, () => { transport?.progress(); session?.progress(); }, transport?.limits.maxResponseBytes);
    session?.finishWithoutCapture(); transport?.beginDelivery();
    logLine(`${requestId} upstream error status=${upstream.status}`);
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    res.end(errorBody);
    await log.write('3-upstream-error.json', errorBody);
};
