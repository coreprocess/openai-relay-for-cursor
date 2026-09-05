import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadConfig, type RelayConfig } from './config.ts';
import { abortOnClientDisconnect, isAuthorized, parseJsonBody, readBody, sendJson } from './http.ts';
import { createRequestLog, logLine } from './log.ts';
import { applyModelAlias } from './modelAlias.ts';
import { pipePassthrough, relayUpstreamError, sendConvertedJson, streamConverted } from './relayResponse.ts';
import { planUpstreamRequest } from './rewrite.ts';
import { startTunnel } from './tunnel.ts';
import { forwardToUpstream } from './upstream.ts';

const handleRequest = async (config: RelayConfig, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const path = req.url ?? '/';
    if (method === 'GET' && path === '/health') {
        return sendJson(res, 200, { ok: true });
    }
    if (!isAuthorized(req, config.relayToken)) {
        logLine(`401 ${method} ${path} (invalid relay token)`);
        return sendJson(res, 401, { error: { message: 'Invalid relay token', type: 'relay_auth_error' } });
    }
    const requestId = randomUUID().slice(0, 8);
    const log = createRequestLog(config.logBodies, config.logDir, requestId);
    const rawBody = await readBody(req);
    const json = parseJsonBody(rawBody, req.headers['content-type']);
    const { body: aliasedJson, alias } = applyModelAlias(json, config.modelPrefix);
    const plan = planUpstreamRequest(path, aliasedJson, {
        aliasEffort: alias?.effort,
        defaultEffort: config.defaultReasoningEffort,
    });

    const modelInfo = alias ? `${alias.aliasedFrom}->${alias.model}` : String(json?.model ?? '-');
    const effortInfo = String((plan.body?.reasoning as { effort?: string } | undefined)?.effort ?? '-');
    const pathInfo = plan.path === path ? path : `${path} -> ${plan.path} (${plan.note})`;
    const clientIp = req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '-';
    logLine(
        `${requestId} ${method} ${pathInfo} model=${modelInfo} effort=${effortInfo} stream=${String(json?.stream ?? false)} ` +
            `keys=[${json ? Object.keys(json).join(',') : '-'}] from=${String(clientIp)} ua=${req.headers['user-agent'] ?? '-'}`,
    );
    await log.write('0-client-headers.json', JSON.stringify({ ...req.headers, authorization: '<redacted>' }, null, 2));
    await log.write('1-client-request.json', rawBody.toString('utf8'));
    if (plan.body) {
        await log.write('2-upstream-request.json', JSON.stringify(plan.body, null, 2));
    }

    const startedAt = Date.now();
    const upstreamBody = plan.body ?? (rawBody.length > 0 ? rawBody : null);
    const signal = abortOnClientDisconnect(res);
    const upstream = await forwardToUpstream(config, method, plan.path, req.headers, upstreamBody, signal);
    logLine(
        `${requestId} upstream status=${upstream.status} x-request-id=${upstream.headers.get('x-request-id') ?? '-'} ` +
            `ttfb=${Date.now() - startedAt}ms convert=${plan.convertToChatCompletions}`,
    );
    if (!upstream.ok) {
        return relayUpstreamError(upstream, res, log, requestId);
    }
    if (!plan.convertToChatCompletions) {
        return pipePassthrough(upstream, res, log);
    }
    if (json?.stream === true) {
        await streamConverted(upstream, res, log);
    } else {
        await sendConvertedJson(upstream, res, log);
    }
    logLine(`${requestId} done total=${Date.now() - startedAt}ms`);
};

const describeError = (error: unknown): string => {
    if (error instanceof Error && error.name === 'AbortError') {
        return 'client disconnected, upstream request aborted';
    }
    return error instanceof Error ? error.message : String(error);
};

const config = loadConfig();
createServer((req, res) => {
    handleRequest(config, req, res).catch((error: unknown) => {
        logLine(`relay error: ${describeError(error)}`);
        if (res.headersSent) {
            res.end();
            return;
        }
        sendJson(res, 502, { error: { message: 'Relay failed to reach upstream', type: 'relay_error' } });
    });
}).listen(config.port, config.host, async () => {
    logLine(
        `relay listening on http://${config.host}:${config.port} -> ${config.upstreamOrigin} ` +
            `(modelPrefix="${config.modelPrefix}" defaultEffort=${config.defaultReasoningEffort ?? '-'} logBodies=${config.logBodies})`,
    );
    if (config.logBodies) {
        logLine(
            `WARNING: LOG_BODIES=1 - full prompts, repository contents and model answers are written to ./${config.logDir}. ` +
                'Set LOG_BODIES=0 and delete the directory when you are done debugging.',
        );
    }
    const publicUrl = await startTunnel(config).catch((error: unknown) => {
        logLine(`tunnel failed: ${describeError(error)}`);
        process.exit(1);
    });
    if (publicUrl) {
        logLine(`tunnel online: ${publicUrl}  ->  Cursor "Override OpenAI Base URL": ${publicUrl}/v1`);
    }
});
