/** Process-local counters; dispatched replay is not proof of provider acceptance or cache hits. */
export class ReplayMetrics {
    readonly startedAt = new Date().toISOString();
    private readonly startedMonotonic = performance.now();
    cachedDispatches = 0;
    observeOnlyDispatches = 0;
    replayingDispatches = 0;
    replayedBlocksDispatched = 0;
    memoryBypasses = 0;
    concurrencyBypasses = 0;
    identityLimitSkips = 0;
    scopeFences = 0;
    preparationFailures = 0;
    upstreamResponses = 0;
    upstreamHttpErrors = 0;
    requestFailures = 0;

    snapshot() {
        return {
            since: this.startedAt, uptimeMs: Math.max(0, Math.floor(performance.now() - this.startedMonotonic)),
            cachedDispatches: this.cachedDispatches, observeOnlyDispatches: this.observeOnlyDispatches,
            replayingDispatches: this.replayingDispatches, replayedBlocksDispatched: this.replayedBlocksDispatched,
            memoryBypasses: this.memoryBypasses, concurrencyBypasses: this.concurrencyBypasses,
            identityLimitSkips: this.identityLimitSkips, scopeFences: this.scopeFences,
            preparationFailures: this.preparationFailures, upstreamResponses: this.upstreamResponses,
            upstreamHttpErrors: this.upstreamHttpErrors, requestFailures: this.requestFailures,
        };
    }
}
