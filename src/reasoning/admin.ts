import { copyCacheSnapshot } from './backup.ts';

const [command, source, destination, ...extra] = process.argv.slice(2);
if (!['backup', 'restore'].includes(command ?? '') || !source || !destination || extra.length) {
    console.error('Usage: pnpm cache:admin <backup|restore> <source.sqlite> <new-destination.sqlite>');
    console.error('Offline only. Stop the owning relay from a session that does not depend on it.');
    process.exitCode = 1;
} else {
    try {
        copyCacheSnapshot(source, destination, command === 'restore');
        console.log(`${command} completed; destination was not activated`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : 'Cache administration failed');
        process.exitCode = 1;
    }
}
