import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RelayConfig } from './config.ts';
import { isAuthorized, parseJsonBody, readBody, sendJson } from './http.ts';
import { createRequestLog, logLine } from './log.ts';
import { applyModelAlias } from './modelAlias.ts';
import type { ReplayRuntime } from './reasoning/runtime.ts';
import type { ReplaySession } from './reasoning/session.ts';
import { pipePassthrough, relayUpstreamError, sendConvertedJson, streamConverted } from './relayResponse.ts';
import { planUpstreamRequest } from './rewrite.ts';
import { forwardToUpstream } from './upstream.ts';
import { validateGenerationBody } from './requestValidation.ts';
import { RequestTransport, transportLimits } from './transport.ts';

export const handleRequest = async (config: RelayConfig, runtime: ReplayRuntime, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const path = req.url ?? '/';
    if (method === 'GET' && path === '/health') return sendJson(res, 200, { ok: true });
    if (!isAuthorized(req, config.relayToken)) {
        return sendJson(res, 401, { error: { message: 'Invalid relay token', type: 'relay_auth_error' } });
    }
    const transport = new RequestTransport(res, transportLimits(config));
    const signal = transport.controller.signal;
    const requestId = randomUUID().slice(0, 8);
    const log = createRequestLog(config.logBodies, config.logDir, requestId);
    let session: ReplaySession | null = null;
    try {
        const rawBody = await readBody(req, transport.limits.maxRequestBytes, transport.progress);
        const json = parseJsonBody(rawBody, req.headers['content-type']);
        if (method === 'POST' && /\/(chat\/completions|responses)(\?|$)/.test(path)) validateGenerationBody(json);
        const { body: aliasedJson, alias } = applyModelAlias(json, config.modelPrefix);
        const plan = planUpstreamRequest(path, aliasedJson, { aliasEffort: alias?.effort, defaultEffort: config.defaultReasoningEffort });
        await log.write('0-client-headers.json', JSON.stringify({ ...req.headers, authorization: '<redacted>' }, null, 2));
        if (log.enabled) await log.write('1-client-request.json', rawBody.toString('utf8'));
        if (signal.aborted) throw new Error('Client disconnected');
        const generating = method === 'POST' && /\/(chat\/completions|responses)(\?|$)/.test(path);
        const prepared = runtime.prepare(aliasedJson, plan.body, req.headers, generating, plan.path, plan.convertToChatCompletions);
        session = prepared.session;
        session?.bind(res);
        if (signal.aborted || res.destroyed) throw new Error('Client disconnected');
        const combinedSignal = session ? AbortSignal.any([signal, session.controller.signal]) : signal;
        const payload = prepared.payload ?? (plan.body ? Buffer.from(JSON.stringify(plan.body)) : rawBody.length ? rawBody : null);
        // Intent transaction and transport invocation stay in one synchronous turn.
        const pending = forwardToUpstream(config, method, plan.path, req.headers, payload, combinedSignal);
        const upstream = await pending;
        runtime.metrics.upstreamResponses++;
        if (!upstream.ok) runtime.metrics.upstreamHttpErrors++;
        transport.progress(); session?.progress();
        if (payload && log.enabled) await log.write('2-upstream-request.json', payload.toString('utf8'));
        logLine(`${requestId} upstream status=${upstream.status} convert=${plan.convertToChatCompletions}`);
        if (!upstream.ok) {
            if (upstream.status === 400 || upstream.status === 422) session?.rejectReplay();
            await relayUpstreamError(upstream, res, log, requestId, transport, session);
            return;
        }
        if (!plan.convertToChatCompletions) return await pipePassthrough(upstream, res, log, transport);
        if (json?.stream === true) await streamConverted(upstream, res, log, session, transport);
        else await sendConvertedJson(upstream, res, log, session, transport);
    } catch (error) {
        transport.abort(); session?.abort(); throw error;
    } finally {
        session?.ensureCompleted(); session?.requestFinished();
    }
};
