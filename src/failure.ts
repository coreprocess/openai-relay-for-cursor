export type FailureReason =
    | 'client_disconnected' | 'client_write_error' | 'upstream_idle_timeout' | 'delivery_timeout'
    | 'cache_generation_timeout' | 'cache_delivery_timeout' | 'client_backpressure_timeout'
    | 'upstream_stream_incomplete' | 'upstream_protocol_error' | 'upstream_body_limit'
    | 'upstream_sse_limit' | 'request_aborted' | 'cache_session_aborted';

/** Fixed reason codes only: never emit arbitrary provider messages, URLs, headers or payloads. */
export class RelayFailure extends Error {
    readonly reason: FailureReason;
    constructor(reason: FailureReason) { super(reason); this.name = 'RelayFailure'; this.reason = reason; }
}

const safeNames = new Set(['AbortError', 'TimeoutError', 'TypeError', 'SyntaxError', 'RangeError',
    'InvalidRequestError', 'RequestBodyLimitError', 'CacheUnavailableError']);
const safeCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
    'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR', 'ERR_SQLITE_ERROR', 'ENOSPC', 'EIO']);
export const safeFailure = (error: unknown, signalReason?: unknown) => {
    const typed = signalReason instanceof RelayFailure ? signalReason : error instanceof RelayFailure ? error : null;
    const e = error instanceof Error ? error : null;
    const code = (e as (Error & { code?: unknown }) | null)?.code;
    const causeCode = e?.cause && typeof e.cause === 'object' ? (e.cause as { code?: unknown }).code : null;
    return {
        reason: typed?.reason ?? 'request_failed',
        errorType: e && safeNames.has(e.name) ? e.name : 'Error',
        errorCode: typeof code === 'string' && safeCodes.has(code) ? code : null,
        causeCode: typeof causeCode === 'string' && safeCodes.has(causeCode) ? causeCode : null,
    };
};
