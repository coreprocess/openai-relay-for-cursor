import type { IncomingMessage, ServerResponse } from 'node:http';

export type JsonBody = Record<string, unknown>;

export class RequestBodyLimitError extends Error {}

export const readBody = async (req: IncomingMessage, maxBytes = 64 * 1024 * 1024, progress?: () => void): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    // Non-destroying early return lets us send an explicit 413 for oversized chunked bodies.
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        progress?.();
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (buffer.length > maxBytes - bytes) throw new RequestBodyLimitError('Request body exceeds relay limit');
        bytes += buffer.length;
        chunks.push(buffer);
    }
    return Buffer.concat(chunks, bytes);
};

export const parseJsonBody = (raw: Buffer, contentType: string | undefined): JsonBody | null => {
    if (raw.length === 0 || !contentType?.includes('application/json')) {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(raw.toString('utf8'));
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonBody) : null;
    } catch {
        return null;
    }
};

export const isAuthorized = (req: IncomingMessage, relayToken: string): boolean => {
    const header = req.headers.authorization ?? '';
    return header === `Bearer ${relayToken}`;
};

export const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
};

/** Aborts when the client goes away before the response is finished (e.g. "Stop" in Cursor). */
export const abortOnClientDisconnect = (res: ServerResponse): AbortSignal => {
    const controller = new AbortController();
    res.once('close', () => {
        if (!res.writableFinished) controller.abort();
    });
    res.once('error', () => controller.abort());
    if (res.destroyed) controller.abort();
    return controller.signal;
};
