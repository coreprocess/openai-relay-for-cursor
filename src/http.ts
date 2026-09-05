import type { IncomingMessage, ServerResponse } from 'node:http';

export type JsonBody = Record<string, unknown>;

export const readBody = async (req: IncomingMessage): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
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
    res.on('close', () => {
        if (!res.writableFinished) {
            controller.abort();
        }
    });
    return controller.signal;
};
