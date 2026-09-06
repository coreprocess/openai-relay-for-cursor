import type { ServerResponse } from 'node:http';
import { RelayFailure } from './failure.ts';

export const writeClientFrame = (response: ServerResponse, frame: string | Uint8Array, timeoutMs = 30_000): Promise<void> => {
    if (response.destroyed) return Promise.reject(new RelayFailure('client_disconnected'));
    if (response.write(frame)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new RelayFailure('client_backpressure_timeout'));
            response.destroy();
        }, timeoutMs);
        timer.unref();
        const cleanup = (): void => {
            clearTimeout(timer);
            response.off('drain', drained);
            response.off('close', closed);
            response.off('error', failed);
        };
        const drained = (): void => { cleanup(); resolve(); };
        const closed = (): void => { cleanup(); reject(new RelayFailure('client_disconnected')); };
        const failed = (error: Error): void => { cleanup(); reject(error); };
        response.once('drain', drained);
        response.once('close', closed);
        response.once('error', failed);
    });
};
