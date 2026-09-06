import { createRelay } from './app.ts';
import { loadConfig } from './config.ts';
import { logLine } from './log.ts';
import { startTunnel, stopTunnel } from './tunnel.ts';

const config = loadConfig();
const relay = createRelay(config);
let stopping = false;
const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
        await relay.close();
        await stopTunnel();
    } catch {
        logLine('relay shutdown failed');
        process.exitCode = 1;
    }
};
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
try {
    await relay.startAdmin();
    if (config.adminSocket) logLine('private local admin socket enabled');
} catch {
    logLine('private admin startup failed; relay did not start');
    await shutdown();
    process.exitCode = 1;
}
if (!stopping) relay.server.listen(config.port, config.host, async () => {
    logLine(`relay listening on http://${config.host}:${config.port} -> ${config.upstreamOrigin} reasoningCache=${config.cache.enabled}`);
    if (config.logBodies) logLine('WARNING: LOG_BODIES=1 writes sensitive prompts, output and replay payloads to disk.');
    try {
        const url = await startTunnel(config);
        if (url) logLine(`tunnel online: ${url} -> Cursor base URL: ${url}/v1`);
    } catch {
        logLine('tunnel startup failed');
        await shutdown();
        process.exitCode = 1;
    }
});
