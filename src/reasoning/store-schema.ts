import type { DatabaseSync } from 'node:sqlite';

export function initializeSchema(db: DatabaseSync): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS scopes (
            digest TEXT PRIMARY KEY, credential TEXT NOT NULL, model TEXT NOT NULL,
            caller TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1, snapshot TEXT NOT NULL DEFAULT ''
        ) STRICT;
        CREATE INDEX IF NOT EXISTS scopes_identity ON scopes(credential, model, caller);
        CREATE TABLE IF NOT EXISTS snapshots (
            scope TEXT NOT NULL REFERENCES scopes(digest), snapshot TEXT NOT NULL, seen_at REAL NOT NULL,
            PRIMARY KEY(scope, snapshot)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS markers (
            scope TEXT NOT NULL REFERENCES scopes(digest), kind TEXT NOT NULL
                CHECK(kind IN ('start-poison', 'end-conflict')),
            digest TEXT NOT NULL, created_at REAL NOT NULL,
            PRIMARY KEY(scope, kind, digest)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS intents (
            id TEXT PRIMARY KEY, scope TEXT NOT NULL REFERENCES scopes(digest), generation INTEGER NOT NULL,
            start_digest TEXT NOT NULL, prior_plan TEXT NOT NULL, deadline REAL NOT NULL,
            end_digest TEXT, phase TEXT NOT NULL CHECK(phase IN ('dispatch', 'delivery'))
        ) STRICT;
        CREATE INDEX IF NOT EXISTS intents_position ON intents(scope, start_digest);
        CREATE TABLE IF NOT EXISTS observations (
            scope TEXT NOT NULL REFERENCES scopes(digest), end_digest TEXT NOT NULL,
            start_digest TEXT NOT NULL, payload_fingerprint TEXT NOT NULL, output_hash TEXT,
            envelope_fingerprint TEXT NOT NULL, prior_plan TEXT NOT NULL, generation INTEGER NOT NULL,
            producing_intent_id TEXT NOT NULL, snapshot TEXT NOT NULL, replayable INTEGER NOT NULL,
            created_at REAL NOT NULL, PRIMARY KEY(scope, end_digest)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS observations_snapshot ON observations(scope, snapshot);
        CREATE TABLE IF NOT EXISTS payloads (
            scope TEXT NOT NULL, end_digest TEXT NOT NULL, output_json TEXT NOT NULL,
            touched_at REAL NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(scope, end_digest),
            FOREIGN KEY(scope, end_digest) REFERENCES observations(scope, end_digest)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS dependencies (
            scope TEXT NOT NULL, child_end TEXT NOT NULL, ancestor_end TEXT NOT NULL,
            PRIMARY KEY(scope, child_end, ancestor_end),
            FOREIGN KEY(scope, child_end) REFERENCES payloads(scope, end_digest) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX IF NOT EXISTS dependencies_ancestor ON dependencies(scope, ancestor_end);
        CREATE TABLE IF NOT EXISTS intent_dependencies (
            intent_id TEXT NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
            scope TEXT NOT NULL, end_digest TEXT NOT NULL, PRIMARY KEY(intent_id, scope, end_digest)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS intent_dependencies_record ON intent_dependencies(scope, end_digest);
    `);
    const version = db.prepare("SELECT value FROM metadata WHERE key = 'schema-version'").get();
    if (version && version.value !== '1' && version.value !== '2') throw new Error('Unsupported replay store schema');
    db.prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES ('record-version', '0')").run();
    for (const [table, columns] of [
        ['observations', 'start_digest, payload_fingerprint, output_hash, envelope_fingerprint, prior_plan, generation, producing_intent_id, snapshot, replayable, created_at'],
        ['payloads', 'output_json, touched_at, bytes'],
    ]) {
        if (!db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === 'row_version')) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN row_version INTEGER NOT NULL DEFAULT 0`);
        }
        for (const [suffix, event] of [['insert', 'INSERT'], ['update', `UPDATE OF ${columns}`]]) {
            db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_version_${suffix} AFTER ${event} ON ${table}
                BEGIN
                    UPDATE metadata SET value = CAST(value AS INTEGER) + 1 WHERE key = 'record-version';
                    UPDATE ${table} SET row_version = (SELECT CAST(value AS INTEGER) FROM metadata WHERE key = 'record-version')
                        WHERE scope = new.scope AND end_digest = new.end_digest;
                END`);
        }
    }
    db.prepare("INSERT INTO metadata(key, value) VALUES ('schema-version', '2') ON CONFLICT(key) DO UPDATE SET value = '2'").run();
}

export function putMarker(db: DatabaseSync, scope: string, kind: 'start-poison' | 'end-conflict', digest: string, now: number): void {
    db.prepare('INSERT OR IGNORE INTO markers(scope, kind, digest, created_at) VALUES (?, ?, ?, ?)')
        .run(scope, kind, digest, now);
}

export function recoverIntents(db: DatabaseSync, now: number, deadline?: number): void {
    const predicate = deadline === undefined ? '' : 'WHERE deadline <= ?';
    const args = deadline === undefined ? [] : [deadline];
    db.prepare(`INSERT OR IGNORE INTO markers(scope, kind, digest, created_at)
        SELECT scope, 'start-poison', start_digest, ? FROM intents ${predicate}`).run(now, ...args);
    db.prepare(`DELETE FROM intents ${predicate}`).run(...args);
}
