import type { JsonBody } from './http.ts';

const reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export type ModelAlias = {
    /** Real OpenAI model name to send upstream. */
    model: string;
    /** Reasoning effort encoded in the alias suffix, if any. */
    effort: string | undefined;
    /** The alias as requested by the client, or null if no aliasing applied. */
    aliasedFrom: string | null;
};

/**
 * Cursor's backend refuses model names it knows from its own registry when a custom base URL is
 * used, and offers no reasoning control for custom models. Clients therefore use aliases of the
 * form `<prefix><model>[-<effort>]`, e.g. `relay-gpt-6-astra-high` -> model `gpt-6-astra`, effort `high`.
 */
export const resolveModelAlias = (requested: string, prefix: string): ModelAlias => {
    if (prefix.length === 0 || !requested.startsWith(prefix)) {
        return { model: requested, effort: undefined, aliasedFrom: null };
    }
    const rest = requested.slice(prefix.length);
    const effort = reasoningEfforts.find((candidate) => rest.endsWith(`-${candidate}`));
    const model = effort ? rest.slice(0, -(effort.length + 1)) : rest;
    return { model, effort, aliasedFrom: requested };
};

export type AliasedBody = { body: JsonBody | null; alias: ModelAlias | null };

export const applyModelAlias = (body: JsonBody | null, prefix: string): AliasedBody => {
    if (body === null || typeof body.model !== 'string') {
        return { body, alias: null };
    }
    const alias = resolveModelAlias(body.model, prefix);
    if (alias.aliasedFrom === null) {
        return { body, alias: null };
    }
    return { body: { ...body, model: alias.model }, alias };
};
