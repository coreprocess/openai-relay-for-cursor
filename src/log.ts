import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const logLine = (message: string): void => {
    console.log(`[${new Date().toISOString()}] ${message}`);
};

export const truncate = (text: string, maxLength = 2000): string =>
    text.length <= maxLength ? text : `${text.slice(0, maxLength)}… (${text.length - maxLength} more chars)`;

export type RequestLog = {
    /** Writes one artifact of the request, e.g. `1-client-request.json`. No-op when body logging is off. */
    write: (step: string, content: string) => Promise<void>;
};

/**
 * All artifacts of one relayed request share the same timestamp + id prefix so they sort together:
 *   <ts>-<id>-1-client-request.json     what Cursor sent
 *   <ts>-<id>-2-upstream-request.json   what we sent to OpenAI (translated, without auth)
 *   <ts>-<id>-3-upstream-response.*     what OpenAI returned (raw SSE or JSON)
 *   <ts>-<id>-4-client-response.*       what we returned to Cursor
 */
export const createRequestLog = (enabled: boolean, logDir: string, requestId: string): RequestLog => {
    const prefix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${requestId}`;
    return {
        write: async (step, content) => {
            if (!enabled) {
                return;
            }
            await mkdir(logDir, { recursive: true });
            await writeFile(join(logDir, `${prefix}-${step}`), content, 'utf8');
        },
    };
};
