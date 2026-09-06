import { createServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { prepareAdminSocket } from './paths.ts';

export type AdminHandlers = { status: () => unknown; snapshot: () => Promise<unknown> };

const respond = (response: ServerResponse, status: number, value: unknown): void => {
    if (response.destroyed || response.writableEnded) return;
    const body = JSON.stringify(value ?? null);
    if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('Admin response too large');
    response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store', Connection: 'close' });
    response.end(body);
};
const failure = (response: ServerResponse, status: number, error: string) => respond(response, status, { error });

export const startAdminServer = async (
    socketPath: string, handlers: AdminHandlers,
): Promise<{ close: () => Promise<void> }> => {
    const location = prepareAdminSocket(socketPath);
    let closing = false;
    let activeSnapshot: Promise<void> | undefined;
    let closePromise: Promise<void> | undefined;
    const headerTimers = new Map<Socket, NodeJS.Timeout>();
    const server = createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000,
        connectionsCheckingInterval: 1000 }, (request, response) => {
        clearTimeout(headerTimers.get(request.socket));
        headerTimers.delete(request.socket);
        if (closing) return failure(response, 503, 'Admin server is shutting down');
        if (request.rawHeaders.length > 64) return failure(response, 431, 'Too many headers');
        if (!['GET', 'POST'].includes(request.method ?? '')) return failure(response, 405, 'Method not allowed');
        if (request.url?.includes('?')) return failure(response, 400, 'Query parameters are not accepted');
        if (!['/status', '/snapshot'].includes(request.url ?? '')) return failure(response, 404, 'Admin endpoint not found');
        const expected = request.url === '/status' ? 'GET' : 'POST';
        if (request.method !== expected) {
            response.setHeader('Allow', expected);
            return failure(response, 405, 'Method not allowed');
        }
        if (request.headers['transfer-encoding'] !== undefined ||
            (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) {
            return failure(response, 400, 'Request bodies are not accepted');
        }
        let hasBody = false;
        request.on('error', () => response.destroy());
        request.on('data', () => { hasBody = true; failure(response, 400, 'Request bodies are not accepted'); });
        request.on('end', () => {
            if (hasBody || response.destroyed) return;
            if (closing) return failure(response, 503, 'Admin server is shutting down');
            if (request.url === '/status') {
                try { respond(response, 200, handlers.status()); } catch { failure(response, 500, 'Admin status failed'); }
                return;
            }
            if (activeSnapshot) return failure(response, 409, 'A snapshot is already in progress');
            activeSnapshot = Promise.resolve().then(() => handlers.snapshot()).then(
                (result) => respond(response, 200, result),
            ).catch(() => failure(response, 500, 'Admin snapshot failed')).finally(() => { activeSnapshot = undefined; });
        });
        request.resume();
    });
    // Retain header names to reject excess fields rather than silently truncating them.
    server.maxHeadersCount = 0;
    server.maxRequestsPerSocket = 1;
    server.maxConnections = 64;
    server.setTimeout(120_000, (socket) => socket.destroy());
    server.on('connection', (socket) => {
        const timer = setTimeout(() => socket.destroy(), 5000);
        timer.unref();
        headerTimers.set(socket, timer);
        socket.once('close', () => { clearTimeout(timer); headerTimers.delete(socket); });
    });
    server.on('checkContinue', (_request, response) => failure(response, 417, 'Expect headers are not accepted'));
    server.on('checkExpectation', (_request, response) => failure(response, 417, 'Expect headers are not accepted'));
    const rejectProtocol = (_request: unknown, socket: import('node:stream').Duplex) => {
        socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    };
    server.on('upgrade', rejectProtocol);
    server.on('connect', rejectProtocol);
    server.on('clientError', (error, socket) => {
        if (!socket.writable) return socket.destroy();
        const status = (error as NodeJS.ErrnoException).code === 'HPE_HEADER_OVERFLOW' ? 431 : 400;
        socket.end(`HTTP/1.1 ${status} Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    });
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(location.bindingPath, () => { server.off('error', reject); resolve(); });
        });
        location.publish();
    } catch {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        location.cleanup();
        throw new Error('Cannot start admin socket; check its location, permissions, and whether another relay owns it');
    }
    return { close: () => {
        if (closePromise) return closePromise;
        closing = true;
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
        for (const socket of headerTimers.keys()) socket.destroy();
        server.closeIdleConnections();
        closePromise = Promise.all([stopped, activeSnapshot]).then(() => { location.cleanup(); });
        return closePromise;
    } };
};
