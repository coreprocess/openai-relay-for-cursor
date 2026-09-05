export type RelayConfig = {
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

const requireEnv = (name: string): string => {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Environment variable ${name} is missing (see .env.example)`);
    }
    return value;
};

export const loadConfig = (): RelayConfig => ({
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
