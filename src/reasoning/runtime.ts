import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import type { RelayConfig } from '../config.ts';
import type { JsonBody } from '../http.ts';
import { logLine } from '../log.ts';
import { prepareIdentity } from './identity.ts';
import { CanonicalLimitError } from './canonical.ts';
import { reconstructInput, selectReplayPlan } from './planner.ts';
import { ReplaySession } from './session.ts';
import { ReplayStore } from './store.ts';
import type { IdentityContext } from './types.ts';
import { CacheAdmission, CacheUnavailableError } from './admission.ts';
import { ReplayMetrics } from './metrics.ts';

export class ReplayRuntime {
    readonly store: ReplayStore | null;
    readonly metrics = new ReplayMetrics();
    private readonly sessions = new Set<ReplaySession>();
    private readonly maintenance: ReturnType<typeof setInterval> | null;
    private closed = false;

    private readonly config: RelayConfig;
    private readonly admission: CacheAdmission;
    constructor(config: RelayConfig) {
        this.config = config;
        const c = config.cache;
        this.admission = new CacheAdmission(c);
        this.store = c.enabled || existsSync(c.dbPath) ? new ReplayStore({
            path: c.dbPath, idleDays: c.idleDays, diskBytes: c.diskBytes, reserveBytes: c.reserveBytes,
            memoryBytes: this.admission.hotBytes, maxEntryBytes: c.maxEntryBytes,
            // Store validation charges a conservative 32x JSON expansion. Its transient copy
            // must fit inside the reserved replay budget, not multiply that budget by 32.
            maxReplayBytes: Math.max(1, Math.floor(this.admission.replayScratchBytes / 32)), maxPlanRecords: c.maxPlanRecords,
        }, { directory: resolve(config.adminSnapshotDir ?? join(homedir(), '.openai-relay-inspection')) }) : null;
        if (!c.enabled && this.store) {
            // Hold exclusive ownership while disabled traffic is unobserved. Otherwise an
            // enabled second instance could consume the gap while this one is still serving.
            try { this.store.markCoverageGap(); }
            catch (error) { this.store.close(); throw error; }
        }
        this.maintenance = c.enabled && this.store ? setInterval(() => {
            try { this.store?.cleanup(); } catch { this.closed = true; logLine('reasoning cache maintenance failed; admission stopped'); }
        }, 60 * 60 * 1000) : null;
        this.maintenance?.unref();
    }

    prepare(original: JsonBody | null, outbound: JsonBody | null, headers: IncomingHttpHeaders, generating: boolean,
        endpoint = '/v1/responses', convertedChat = true): {
        payload: Buffer | null; session: ReplaySession | null;
    } {
        if (this.closed) throw new CacheUnavailableError();
        if (!this.config.cache.enabled || !this.store || !generating || !original || !outbound) return { payload: null, session: null };
        const c = this.config.cache;
        const context: IdentityContext = {
            upstreamOrigin: this.config.upstreamOrigin, endpoint, apiKey: this.config.openAiApiKey,
            relayToken: this.config.relayToken, secret: this.store.secret,
            openaiBeta: typeof headers['openai-beta'] === 'string' ? headers['openai-beta'] : undefined,
            limits: c.limits,
        };
        const underivable = !convertedChat || !Array.isArray(original.messages) || 'input' in original ||
            'previous_response_id' in original || 'conversation' in original;
        if (underivable) {
            // Broad-fence identity must not depend on unbounded/unclassified Responses settings.
            const scope = prepareIdentity({ model: original.model, messages: [] }, {
                model: outbound.model, safety_identifier: outbound.safety_identifier ?? original.safety_identifier ?? original.user,
            }, context).scope;
            try {
                this.store.fence(scope.credential, scope.model,
                    typeof original.user === 'string' || typeof original.safety_identifier === 'string' ? scope.caller : undefined);
                this.metrics.scopeFences++;
            } catch (error) {
                this.metrics.preparationFailures++;
                logLine('reasoning cache safety failure operation=fence');
                throw new CacheUnavailableError(error);
            }
            return { payload: null, session: null };
        }
        let identity;
        try { identity = prepareIdentity(original, outbound, context); }
        catch (error) {
            if (error instanceof CanonicalLimitError) {
                this.metrics.identityLimitSkips++;
                logLine(`reasoning cache skip reason=identity-limit limit=${error.limit}`);
                return { payload: null, session: null };
            }
            throw error;
        }
        const release = this.admission.reserve(identity.canonicalBytes);
        const start = identity.prefixes.at(-1)!;
        if (!release) {
            try { this.store.bypass(identity.scope, start); }
            catch (error) {
                this.metrics.preparationFailures++;
                logLine('reasoning cache safety failure operation=bypass');
                throw new CacheUnavailableError(error);
            }
            if (this.admission.refusalReason(identity.canonicalBytes) === 'maxConcurrent') this.metrics.concurrencyBypasses++;
            else this.metrics.memoryBypasses++;
            logLine(`reasoning cache bypass reason=${this.admission.refusalReason(identity.canonicalBytes)} active=${this.admission.activeSessions} leasedBytes=${this.admission.retainedBytes}; forwarding without replay`);
            return { payload: null, session: null };
        }
        let id: string | undefined;
        try {
            this.store.ensureScope(identity.scope);
            let plan = selectReplayPlan(this.store, identity, c.maxPlanRecords, c.maxReplayBytes);
            const input = plan.length ? reconstructInput(identity, plan) : null;
            if (!input) plan = [];
            const body = identity.eligible ? {
                ...outbound, ...(input ? { input } : {}), store: false,
                include: [...new Set([...(Array.isArray(outbound.include) ? outbound.include : []), 'reasoning.encrypted_content'])],
            } : outbound;
            const payload = Buffer.from(JSON.stringify(body));
            // No await between transactional validation, intent commit, and transport handoff.
            id = this.store.begin(identity.scope, start, plan, Date.now() + c.idleTimeoutMs);
            const session = new ReplaySession(this.store, id, identity, c, () => {
                this.sessions.delete(session);
                release();
            });
            this.sessions.add(session);
            if (identity.eligible) this.metrics.cachedDispatches++; else this.metrics.observeOnlyDispatches++;
            if (plan.length) this.metrics.replayingDispatches++;
            this.metrics.replayedBlocksDispatched += plan.length;
            logLine(`reasoning cache dispatch replacements=${plan.length} eligible=${identity.eligible} active=${this.admission.activeSessions} leasedBytes=${this.admission.retainedBytes}`);
            return { payload, session };
        } catch (error) {
            this.metrics.preparationFailures++;
            release();
            try { if (id) this.store.poison(id); }
            catch (poisonError) { throw new CacheUnavailableError(poisonError); }
            logLine('reasoning cache safety failure operation=prepare');
            throw new CacheUnavailableError(error);
        }
    }

    inspect() {
        const memory = process.memoryUsage();
        return {
            sampledAt: new Date().toISOString(), pid: process.pid, cacheEnabled: this.config.cache.enabled,
            stopping: this.closed, activeCachedSessions: this.admission.activeSessions,
            leasedCacheBytes: this.admission.retainedBytes, cacheBudgetBytes: this.config.cache.memoryBytes,
            processMemory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed },
            counters: this.metrics.snapshot(), store: this.store?.inspect() ?? null,
        };
    }

    createInspectionSnapshot() {
        if (this.closed || !this.store) throw new Error('Cache store unavailable for inspection');
        return this.store.createInspectionSnapshot();
    }

    async waitForInspection(): Promise<void> { await this.store?.waitForInspection(); }

    stop(): void {
        if (this.maintenance) clearInterval(this.maintenance);
        this.closed = true;
        for (const session of [...this.sessions]) session.abort();
    }
    close(): void {
        this.stop();
        this.store?.close();
    }
}
