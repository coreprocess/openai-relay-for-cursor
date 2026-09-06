import { loadCacheConfig } from './reasoning/config.ts';
import type { CacheConfig } from './reasoning/types.ts';
import type { TransportLimits } from './transport.ts';

export type RelayConfig = {
    /** Opt-in private Unix-domain socket; never bound to the public HTTP listener. */
    adminSocket?: string;
    /** Optional private export directory; defaults outside the serving checkout. */
    adminSnapshotDir?: string;
    transport?: Partial<TransportLimits>;
    cache: CacheConfig;
    host: string;
    port: number;
    relayToken: string;
    openAiApiKey: string;
    upstreamOrigin: string;
    /** Alias prefix, e.g. `relay-` for `relay-gpt-6-astra-high`. Empty string disables aliasing. */
    modelPrefix: string;
    /** Reasoning effort used when neither alias suffix nor request specify one. */
    defaultReasoningEffort: string | undefined;
    /** ngrok authtoken; when unset, no tunnel is started. */
    ngrokAuthtoken: string | undefined;
    /** Reserved ngrok domain (e.g. the free dev domain). Unset = random ngrok URL. */
    ngrokDomain: string | undefined;
    logBodies: boolean;
    logDir: string;
};

const optionalTransportLimit = (name: string): number | undefined => {
    const raw = process.env[name];
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
};

const requireEnv = (name: string): string => {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Environment variable ${name} is missing (see .env.example)`);
    }
    return value;
};

export const loadConfig = (): RelayConfig => ({
    adminSocket: process.env.RELAY_ADMIN_SOCKET || undefined,
    adminSnapshotDir: process.env.RELAY_ADMIN_SNAPSHOT_DIR || undefined,
    cache: loadCacheConfig(),
    transport: Object.fromEntries([
        ['maxRequestBytes', optionalTransportLimit('RELAY_MAX_REQUEST_BYTES')],
        ['maxResponseBytes', optionalTransportLimit('RELAY_MAX_RESPONSE_BYTES')],
        ['maxSseEventBytes', optionalTransportLimit('RELAY_MAX_SSE_EVENT_BYTES')],
        ['idleTimeoutMs', optionalTransportLimit('RELAY_IDLE_TIMEOUT_MS')],
        ['deliveryTimeoutMs', optionalTransportLimit('RELAY_DELIVERY_TIMEOUT_MS')],
    ].filter((entry) => entry[1] !== undefined)),
    host: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 8787),
    relayToken: requireEnv('RELAY_TOKEN'),
    openAiApiKey: requireEnv('OPENAI_API_KEY'),
    upstreamOrigin: (process.env.OPENAI_UPSTREAM ?? 'https://api.openai.com').replace(/\/+$/, ''),
    modelPrefix: process.env.MODEL_PREFIX ?? '',
    defaultReasoningEffort: process.env.REASONING_EFFORT || undefined,
    ngrokAuthtoken: process.env.NGROK_AUTHTOKEN || undefined,
    ngrokDomain: process.env.NGROK_DOMAIN || undefined,
    logBodies: process.env.LOG_BODIES === '1',
    logDir: process.env.LOG_DIR ?? 'logs',
});
