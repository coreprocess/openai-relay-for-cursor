import { createServer } from 'node:http';
import type { RelayConfig } from './config.ts';
import { sendJson, RequestBodyLimitError } from './http.ts';
import { logLine } from './log.ts';
import { ReplayRuntime } from './reasoning/runtime.ts';
import { CacheUnavailableError } from './reasoning/admission.ts';
import { handleRequest } from './requestHandler.ts';
import { InvalidRequestError } from './requestValidation.ts';
import { transportLimits } from './transport.ts';
import { startAdminServer } from './admin/server.ts';
import { resolveAdminSocketPath } from './admin/paths.ts';

/** Importable factory. Neither public listener nor private admin socket starts until requested. */
export const createRelay = (config: RelayConfig) => {
    transportLimits(config);
    const runtime = new ReplayRuntime(config);
    const server = createServer((req, res) => {
        handleRequest(config, runtime, req, res).catch((error: unknown) => {
            runtime.metrics.requestFailures++;
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
    let admin: Promise<Awaited<ReturnType<typeof startAdminServer>> | null> | undefined;
    let closing: Promise<void> | undefined;
    const startAdmin = () => {
        if (closing) return Promise.reject(new Error('Relay is stopping'));
        admin ??= config.adminSocket ? startAdminServer(resolveAdminSocketPath(config.adminSocket), {
            status: () => runtime.inspect(), snapshot: () => runtime.createInspectionSnapshot(),
        }) : Promise.resolve(null);
        return admin;
    };
    const close = (): Promise<void> => {
        if (closing) return closing;
        closing = (async () => {
            const stopped = server.listening ? new Promise<void>((resolve, reject) =>
                server.close((error) => error ? reject(error) : resolve())) : Promise.resolve();
            runtime.stop();
            server.closeAllConnections();
            try {
                const localAdmin = await admin?.catch(() => null);
                await localAdmin?.close();
                await stopped;
            } finally {
                // Online backup owns the SQLite handle until its promise settles.
                await runtime.waitForInspection();
                runtime.close();
            }
        })();
        return closing;
    };
    return { server, runtime, startAdmin, close };
};
