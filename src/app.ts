import { createServer } from 'node:http';
import type { RelayConfig } from './config.ts';
import { sendJson, RequestBodyLimitError } from './http.ts';
import { logLine } from './log.ts';
import { ReplayRuntime } from './reasoning/runtime.ts';
import { CacheUnavailableError } from './reasoning/admission.ts';
import { handleRequest } from './requestHandler.ts';
import { InvalidRequestError } from './requestValidation.ts';
import { transportLimits } from './transport.ts';

/** Importable construction for offline tests; never loads .env or starts a tunnel. */
export const createRelay = (config: RelayConfig) => {
    transportLimits(config); // Fail invalid configuration before opening cache files or listening.
    const runtime = new ReplayRuntime(config);
    const server = createServer((req, res) => {
        handleRequest(config, runtime, req, res).catch((error: unknown) => {
            logLine('relay request failed');
            if (res.headersSent) { if (!res.writableFinished) res.destroy(); return; }
            if (error instanceof RequestBodyLimitError) {
                res.setHeader('connection', 'close');
                sendJson(res, 413, { error: { message: error.message, type: 'request_too_large' } });
                return;
            }
            if (error instanceof InvalidRequestError) {
                sendJson(res, 400, { error: { message: error.message, type: 'invalid_request_error' } });
                return;
            }
            if (error instanceof CacheUnavailableError) {
                sendJson(res, 503, { error: { message: 'Reasoning cache safety storage is unavailable', type: 'relay_cache_unavailable' } });
                return;
            }
            sendJson(res, 502, { error: { message: 'Relay failed to reach upstream', type: 'relay_error' } });
        });
    });
    const close = async (): Promise<void> => {
        const stopped = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        runtime.stop();
        server.closeAllConnections();
        try { await stopped; } finally { runtime.close(); }
    };
    return { server, runtime, close };
};
