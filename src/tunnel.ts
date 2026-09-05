import ngrok from '@ngrok/ngrok';
import type { RelayConfig } from './config.ts';
import { logLine } from './log.ts';

/**
 * Starts an embedded ngrok tunnel to the relay port so no separate `ngrok` process is needed.
 * Returns the public base URL to enter in Cursor, or null when no NGROK_AUTHTOKEN is configured.
 */
export const startTunnel = async (config: RelayConfig): Promise<string | null> => {
    if (!config.ngrokAuthtoken) {
        logLine('tunnel disabled (NGROK_AUTHTOKEN not set) - relay is reachable locally only');
        return null;
    }
    const listener = await ngrok.forward({
        addr: `${config.host}:${config.port}`,
        authtoken: config.ngrokAuthtoken,
        domain: config.ngrokDomain,
        onStatusChange: (status: string) => logLine(`tunnel status: ${status}`),
    });
    const publicUrl = listener.url();
    if (!publicUrl) {
        throw new Error('ngrok did not return a public URL');
    }
    const shutdown = async () => {
        await ngrok.disconnect();
        process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return publicUrl;
};
