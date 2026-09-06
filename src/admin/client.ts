import { request } from 'node:http';
import { isAbsolute } from 'node:path';

export type AdminCommand = 'status' | 'snapshot';
const MAX_RESPONSE_BYTES = 1024 * 1024;

const connectionFailure = (error: Error): Error => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ECONNREFUSED') {
        return new Error('Admin socket is unavailable. Enable RELAY_ADMIN_SOCKET and restart the relay, or use --socket /absolute/path.');
    }
    if (code === 'EACCES' || code === 'EPERM') return new Error('Admin socket access denied; run as the owning relay user.');
    return new Error('Admin socket request failed; verify the relay is running and the socket is private.');
};

/** Local IPC only: neither URLs, TCP fallback, request bodies, nor SQL are supported. */
export const requestAdmin = (socketPath: string, command: AdminCommand): Promise<unknown> => {
    if (!isAbsolute(socketPath) || socketPath.includes('\0') || !['status', 'snapshot'].includes(command)) {
        return Promise.reject(new Error('An absolute UNIX admin socket path and a valid command are required'));
    }
    return new Promise((resolve, reject) => {
        const timeoutMs = command === 'snapshot' ? 120_000 : 5000;
        const req = request({ socketPath, path: `/${command}`, method: command === 'status' ? 'GET' : 'POST',
            agent: false, headers: { Accept: 'application/json', Connection: 'close' }, maxHeaderSize: 8192 });
        const finish = (error?: Error, result?: unknown) => {
            clearTimeout(deadline);
            if (error) { reject(error); req.destroy(); } else resolve(result);
        };
        const deadline = setTimeout(() => finish(new Error(`Admin ${command} timed out; check the relay before retrying.`)), timeoutMs);
        deadline.unref();
        req.once('error', (error) => finish(connectionFailure(error)));
        req.once('response', (response) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on('data', (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > MAX_RESPONSE_BYTES) {
                    finish(new Error('Admin response exceeded the 1 MiB limit'));
                    response.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            response.once('error', () => finish(new Error('Admin response was interrupted')));
            response.once('end', () => {
                if (response.statusCode !== 200) {
                    const message = response.statusCode === 409 ? 'A snapshot is already in progress; try again after it completes.' :
                        response.statusCode === 503 ? 'Admin server is shutting down; retry after the relay restarts.' :
                            `Admin ${command} failed (HTTP ${response.statusCode ?? 'unknown'}); check the relay.`;
                    return finish(new Error(message));
                }
                try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch {
                    finish(new Error('Admin server returned an invalid JSON response'));
                }
            });
        });
        req.end();
    });
};
