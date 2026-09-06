import { isAbsolute } from 'node:path';
import { requestAdmin, type AdminCommand } from '../admin/client.ts';
import { resolveAdminSocketPath } from '../admin/paths.ts';

type AdminArguments =
    | { command: 'backup' | 'restore'; source: string; destination: string }
    | { command: AdminCommand; socketPath: string; json: boolean };

export const parseAdminArguments = (
    args: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(),
): AdminArguments => {
    const [command, ...options] = args;
    if (command === 'backup' || command === 'restore') {
        if (options.length !== 2 || !options[0] || !options[1]) throw new Error('Source and new destination are required');
        return { command, source: options[0], destination: options[1] };
    }
    if (command !== 'status' && command !== 'snapshot') throw new Error('Unknown admin command');
    let json = false;
    let explicitSocket: string | undefined;
    for (let index = 0; index < options.length; index++) {
        if (options[index] === '--json' && !json) { json = true; continue; }
        if (options[index] === '--socket' && explicitSocket === undefined) {
            explicitSocket = options[++index];
            if (!explicitSocket || !isAbsolute(explicitSocket) || explicitSocket.includes('\0')) {
                throw new Error('--socket requires an absolute UNIX socket path');
            }
            continue;
        }
        throw new Error('Unexpected or duplicate admin option');
    }
    return { command, json, socketPath: resolveAdminSocketPath(explicitSocket ?? env.RELAY_ADMIN_SOCKET ?? '', cwd) };
};

const main = async (): Promise<void> => {
    let options: AdminArguments;
    try { options = parseAdminArguments(process.argv.slice(2)); } catch (error) {
        console.error(error instanceof Error ? error.message : 'Invalid admin command');
        console.error('Usage: pnpm cache:admin <status|snapshot> [--json] [--socket /absolute/path]');
        console.error('       pnpm cache:admin <backup|restore> <source.sqlite> <new-destination.sqlite>');
        console.error('Backup/restore are offline only. Stop the owner from a session that does not depend on it.');
        process.exitCode = 1;
        return;
    }
    try {
        if ('socketPath' in options) {
            const result = await requestAdmin(options.socketPath, options.command);
            console.log(JSON.stringify(result, null, options.json ? undefined : 2));
            return;
        }
        const { copyCacheSnapshot } = await import('./backup.ts');
        copyCacheSnapshot(options.source, options.destination, options.command === 'restore');
        console.log(`${options.command} completed; destination was not activated`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : 'Cache administration failed');
        process.exitCode = 1;
    }
};

if (import.meta.main) await main();
