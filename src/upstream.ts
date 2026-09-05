import type { IncomingHttpHeaders } from 'node:http';
import type { RelayConfig } from './config.ts';
import type { JsonBody } from './http.ts';

const forwardedRequestHeaders = ['content-type', 'accept', 'openai-beta'];

const buildHeaders = (incoming: IncomingHttpHeaders, apiKey: string): Headers => {
    const headers = new Headers();
    for (const name of forwardedRequestHeaders) {
        const value = incoming[name];
        if (typeof value === 'string') {
            headers.set(name, value);
        }
    }
    headers.set('authorization', `Bearer ${apiKey}`);
    return headers;
};

export const forwardToUpstream = (
    config: RelayConfig,
    method: string,
    path: string,
    incomingHeaders: IncomingHttpHeaders,
    body: Buffer | JsonBody | null,
    signal: AbortSignal,
): Promise<Response> => {
    const headers = buildHeaders(incomingHeaders, config.openAiApiKey);
    const payload = body === null ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body);
    if (payload !== undefined && !headers.has('content-type')) {
        headers.set('content-type', 'application/json');
    }
    return fetch(`${config.upstreamOrigin}${path}`, { method, headers, body: payload, signal });
};
