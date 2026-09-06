import type { ServerResponse } from 'node:http';
import { writeClientFrame } from './clientWrite.ts';

type SseWriterOptions = {
    intervalMs?: number;
    writeTimeoutMs?: number;
    onKeepalive?: (frame: string) => void;
    onError?: (error: unknown) => void;
    now?: () => number;
};

export const createSseWriter = (res: ServerResponse, options: SseWriterOptions = {}): {
    write: (frame: string) => Promise<void>;
    stop: () => void;
} => {
    const { intervalMs = 15_000, writeTimeoutMs = 30_000, now = () => performance.now() } = options;
    for (const [name, value] of Object.entries({ intervalMs, writeTimeoutMs })) {
        if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
            throw new RangeError(`${name} must be a non-negative integer within the timer range`);
        }
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastWrite = now();
    let heartbeat: Promise<void> | undefined;
    let mainBusy = false;
    let failure: { error: unknown } | undefined;
    const throwIfFailed = (): void => { if (failure) throw failure.error; };
    const disconnected = (): boolean => res.destroyed || res.closed || res.writableEnded || res.writableFinished;
    const stop = (): void => {
        stopped = true;
        clearTimeout(timer);
        timer = undefined;
        res.off('finish', stop);
        res.off('close', stop);
        res.off('error', fail);
    };
    const fail = (error: unknown): void => {
        if (failure) return;
        failure = { error };
        stop();
        // Reporting must never turn a handled timer failure into an unhandled rejection.
        try { void Promise.resolve(options.onError?.(error)).catch(() => {}); } catch {}
    };
    const schedule = (delay = intervalMs): void => {
        if (stopped || intervalMs === 0) return;
        clearTimeout(timer);
        timer = setTimeout(tick, delay);
        timer.unref();
    };
    const publish = async (frame: string): Promise<void> => {
        if (disconnected()) throw new Error('Client disconnected');
        lastWrite = now();
        schedule();
        await writeClientFrame(res, frame, writeTimeoutMs);
    };
    const tick = (): void => {
        timer = undefined;
        if (stopped) return;
        if (disconnected()) { stop(); return; }
        if (mainBusy || heartbeat || res.writableNeedDrain || res.writableLength > 0) {
            schedule();
            return;
        }
        const remaining = intervalMs - (now() - lastWrite);
        if (remaining > 0) { schedule(remaining); return; }
        heartbeat = (async () => {
            try {
                const frame = ': keepalive\n\n';
                await publish(frame);
                if (!failure) void Promise.resolve(options.onKeepalive?.(frame)).catch(fail);
            } catch (error) { fail(error); }
        })().finally(() => { heartbeat = undefined; });
    };
    res.once('finish', stop);
    res.once('close', stop);
    res.once('error', fail);
    if (disconnected()) stop();
    else schedule();
    return {
        // Owners await each main write and stop keepalives before writing terminal frames.
        write: async (frame) => {
            throwIfFailed();
            if (mainBusy) throw new Error('Concurrent SSE writes are not supported');
            mainBusy = true;
            try {
                if (heartbeat) await heartbeat;
                throwIfFailed();
                await publish(frame);
                throwIfFailed();
            } catch (error) {
                fail(error);
                throw failure!.error;
            } finally { mainBusy = false; }
        },
        stop,
    };
};
