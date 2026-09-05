# OpenAI Relay for Cursor

Use **GPT-6 Astra** (and any other OpenAI model that needs the Responses API) inside **Cursor's Agent**
with your own OpenAI API key.

Cursor's "bring your own key" (BYOK) path talks Chat Completions to a custom base URL, and Cursor's
backend refuses to route registry models such as `gpt-6-astra` over it. OpenAI in turn only supports
function tools *with reasoning* for Astra via the Responses API. This relay sits in between, runs on
your machine, and translates both directions. It ships with an embedded ngrok tunnel, so a single
`pnpm start` gives you a public HTTPS endpoint for Cursor.

```
Cursor  →  Cursor backend  →  https://<your-domain>.ngrok-free.app/v1  →  relay on your machine  →  api.openai.com
```

Your real OpenAI key never leaves your machine; Cursor only gets a random relay token.

## Use case 1: GPT-6 Astra in Cursor's Agent

### What you need

- Node.js ≥ 24 and pnpm
- An OpenAI API key from a project that has access to `gpt-6-astra`
- A free [ngrok](https://ngrok.com) account (for the authtoken and the free, permanent dev domain)
- Cursor with "Use OpenAI API key" available in *Settings → Models*

### 1. Install and configure

```bash
git clone https://github.com/coreprocess/openai-relay-for-cursor.git
cd openai-relay-for-cursor
pnpm install
cp .env.example .env
```

Edit `.env`:

| Variable          | Value                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`  | your OpenAI key                                                                           |
| `RELAY_TOKEN`     | a random secret, e.g. `openssl rand -hex 32` – this is what you enter in Cursor           |
| `NGROK_AUTHTOKEN` | from [dashboard.ngrok.com → Your Authtoken](https://dashboard.ngrok.com/get-started/your-authtoken) |
| `NGROK_DOMAIN`    | your free dev domain from [dashboard.ngrok.com → Domains](https://dashboard.ngrok.com/domains), e.g. `xyz.ngrok-free.app` |

> **About the tunnel.** Cursor streams responses as Server-Sent Events, and the tunnel has to pass them
> through *unbuffered*. If it buffers, the protocol part works fine (status 200 in the relay log) but
> Cursor shows nothing until the whole answer is done, or times out. ngrok does this correctly, which
> is why it is embedded. Cloudflare *Quick* Tunnels buffer SSE and will not work; named Cloudflare
> tunnels and Tailscale Funnel do (see [use case 4](#use-case-4-bring-your-own-tunnel-or-run-locally-only)).
> The ngrok free plan includes 1 GB of egress per month; agent sessions with large contexts add up, so
> keep an eye on the usage page in the ngrok dashboard.

### 2. Start

```bash
pnpm start
```

```
relay listening on http://127.0.0.1:8787 -> https://api.openai.com (modelPrefix="relay-" defaultEffort=medium logBodies=false)
tunnel status: connected
tunnel online: https://xyz.ngrok-free.app  ->  Cursor "Override OpenAI Base URL": https://xyz.ngrok-free.app/v1
```

### 3. Configure Cursor

*Settings → Models → API Keys*:

| Field                    | Value                                                          |
| ------------------------ | -------------------------------------------------------------- |
| OpenAI API Key           | your `RELAY_TOKEN` (**not** the real OpenAI key)               |
| Override OpenAI Base URL | `https://xyz.ngrok-free.app/v1`                                |
| Custom Models            | `relay-gpt-6-astra-high`, `relay-gpt-6-astra-medium`, `relay-gpt-6-astra-low` |

Keep "Use OpenAI API key" enabled, open a **new chat**, pick a `relay-…` model explicitly (not Auto).
Agent mode with tool calls works; the relay was verified with multi-turn tool round trips.

**Why aliases?** If you enter `gpt-6-astra` directly, Cursor's backend answers
`Routing failed: model registry mcid "gpt-6-astra" has no routable deployment ... cannot serve client
protocol "chat_completions"` and never contacts your base URL. Unknown names are treated as generic
custom models and are sent to the base URL. The relay resolves `relay-<model>-<effort>` back to the real
model and reasoning effort. The prefix has to be at the start so Cursor does not match the name against
its `gpt-*` patterns.

**Reasoning effort per model entry.** Cursor offers no reasoning control for custom models, so the
alias suffix carries it: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. Without a suffix,
`REASONING_EFFORT` applies. Add as many entries as you like, e.g. `relay-gpt-6-astra-xhigh`.

## Use case 2: Any OpenAI model with your own key, key stays local

The relay is model-agnostic. `relay-gpt-5.5-low` → `gpt-5.5` with low effort. Everything sent to
`/chat/completions` is forwarded to `/responses`, so models that only exist there work too. Your key is
only stored in `.env` on your machine; Cursor and its backend only ever see the relay token, and you
can rotate the relay token without touching OpenAI.

## Use case 3: See exactly what Cursor sends and receives

Set `LOG_BODIES=1` and every request produces four files in `logs/` sharing one timestamp+id prefix:

| File                       | Content                                                   |
| -------------------------- | --------------------------------------------------------- |
| `1-client-request.json`    | what Cursor sent (Chat Completions shape, tools, prompt)  |
| `2-upstream-request.json`  | what the relay sent to OpenAI (Responses shape, no auth)  |
| `3-upstream-response.sse`  | raw Responses API event stream from OpenAI                |
| `4-client-response.sse`    | Chat Completions chunks returned to Cursor                |

Request *shape* and *content* are logged separately on purpose. The console always prints one line
per request with path, translation, model alias resolution, effort, top-level body keys, origin IP,
user agent, upstream status, OpenAI `x-request-id`, time to first byte and total duration – but never
prompt content. Fields the translation does not know show up as `dropped=[...]`. Only `LOG_BODIES=1`
writes content, and the relay prints a warning at startup while it is on.

The log files contain your prompts, repository contents and answers. Turn `LOG_BODIES` off when you
are done debugging and delete `logs/`.

## Use case 4: Bring your own tunnel or run locally only

Leave `NGROK_AUTHTOKEN` empty and the relay only listens on `HOST:PORT`. Put any HTTPS tunnel or reverse
proxy in front of it that passes Server-Sent Events through unbuffered (see the tunnel note in use
case 1): named Cloudflare tunnels, Tailscale Funnel and the ngrok CLI work, Cloudflare *Quick* Tunnels
do not. To verify a tunnel, run the `curl -sN` test from [Troubleshooting](#troubleshooting) against its
public URL – the chunks must arrive one by one, not all at once at the end.

## How it works

1. **Auth**: requires `Authorization: Bearer <RELAY_TOKEN>` and replaces it with `OPENAI_API_KEY`.
   Only `content-type`, `accept` and `openai-beta` are forwarded from the incoming request.
2. **Model alias**: `<MODEL_PREFIX><model>[-<effort>]` → real model plus `reasoning.effort`.
   Priority: alias suffix > `reasoning_effort` in the request > `REASONING_EFFORT`.
3. **`/chat/completions` → `/responses`**, for two request shapes:
   - Responses-shaped body (`input`; Cursor sends this for registry models, see Cursor forum thread
     153019): only the Chat-Completions-only `stream_options` is removed.
   - Chat-Completions-shaped body (`messages`; Cursor sends this for alias models): translated.
     `messages` → input items (`system`/`developer`/`user` text and `image_url` → `input_image`,
     `assistant.tool_calls` → `function_call`, `role: tool` → `function_call_output` with text or
     image parts), `tools` flattened, `tool_choice`, `max_completion_tokens`/`max_tokens` →
     `max_output_tokens`, `user` → `safety_identifier`, `temperature`, `top_p`, `parallel_tool_calls`,
     `metadata` passed through, `stream_options` and `n` dropped.
4. **Response conversion**: Responses SSE events → `chat.completion.chunk` frames: `delta.content`,
   `delta.refusal`, `delta.tool_calls` (with `index`, `id`, streamed `arguments`), `finish_reason`
   (`stop`, `tool_calls`, `length`), a final usage chunk incl. `reasoning_tokens` and `cached_tokens`,
   then `data: [DONE]`. `error`/`response.failed` become `{"error": ...}` frames. Non-streaming
   responses are converted to a `chat.completion` object.
5. **Passthrough**: other paths (e.g. `/v1/models`) are forwarded unchanged, including OpenAI errors
   (status and body).
6. **Cancellation**: when Cursor stops a generation, the upstream request is aborted.

## Configuration

| Variable           | Default                  | Description                                                        |
| ------------------ | ------------------------ | ------------------------------------------------------------------ |
| `OPENAI_API_KEY`   | –                        | Real OpenAI key (required)                                         |
| `OPENAI_UPSTREAM`  | `https://api.openai.com` | Upstream origin                                                    |
| `RELAY_TOKEN`      | –                        | Secret Cursor uses as "OpenAI API Key" (required)                  |
| `HOST` / `PORT`    | `127.0.0.1` / `8787`     | Local bind address                                                 |
| `MODEL_PREFIX`     | –                        | Alias prefix, e.g. `relay-`. Empty disables aliasing               |
| `REASONING_EFFORT` | –                        | Fallback effort when alias suffix and request do not specify one   |
| `NGROK_AUTHTOKEN`  | –                        | Starts the embedded tunnel when set                                |
| `NGROK_DOMAIN`     | –                        | Reserved ngrok domain; empty = random URL per start                |
| `LOG_BODIES`       | `0`                      | `1` writes the four per-request files                              |
| `LOG_DIR`          | `logs`                   | Directory for those files                                          |

## Troubleshooting

| Observation                                                       | Meaning / what to do                                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Cursor: `Routing failed: model registry mcid ... chat_completions` | You selected a registry name (e.g. `gpt-6-astra`). Use a `relay-…` alias    |
| No request reaches the relay, `curl <public-url>/health` works    | Cursor is not using the base URL: check the key toggle, start a new chat     |
| `401 ... invalid relay token`                                      | Cursor has a different token than `RELAY_TOKEN`                              |
| `upstream status=400 ... reasoning_effort ... /v1/chat/completions` | Request bypassed the translation; check the path Cursor calls in the log   |
| `upstream status=404 model_not_found`                              | The resolved model (`model=alias->real` in the log) is not enabled for your key/project |
| Cursor renders nothing despite `status=200`                        | Compare `4-client-response.sse` with `3-upstream-response.sse`               |
| Answer appears only at the very end, or Cursor times out           | Your tunnel buffers SSE (e.g. Cloudflare Quick Tunnel). Use ngrok or a named tunnel, see the tunnel note in use case 1 |
| `dropped=[...]` in the request line                                | Cursor sent a field the translation does not map yet – please open an issue  |
| `tunnel failed: ...`                                               | Domain already in use by another agent (e.g. the `ngrok` CLI) or wrong token |

Test the public endpoint without Cursor:

```bash
curl -sN https://<your-domain>.ngrok-free.app/v1/chat/completions \
  -H "Authorization: Bearer <RELAY_TOKEN>" -H "Content-Type: application/json" \
  -d '{"model":"relay-gpt-6-astra-low","stream":true,"messages":[{"role":"user","content":"Reply with OK only."}]}'
```

Expected: `chat.completion.chunk` frames containing `"content":"OK"` and a final `data: [DONE]`.

## Security notes

Relay experiments tend to live longer than intended. Treat this one accordingly:

- **Use a dedicated OpenAI project and key** for the relay, with a monthly budget set in the OpenAI
  dashboard. Revoking or rotating it then never affects anything else.
- **The relay token is a credential.** Anyone who has it and your tunnel URL can spend on your key.
  Generate it with `openssl rand -hex 32`, don't reuse it, and rotate it (one line in `.env`, one field
  in Cursor) whenever you're unsure who has seen it.
- **Rotate the OpenAI key after testing phases**, especially if it was ever pasted into a chat, a
  ticket or a screenshot while you were debugging.
- **`LOG_BODIES=0` in normal operation.** With `1`, every request writes your full prompt and repository
  excerpts to disk. Delete `logs/` afterwards.
- **Stop the relay when you don't need it.** With `NGROK_DOMAIN` set, the endpoint is reachable from the
  internet whenever the process runs; without the process, the URL is dead.
- Requests to the relay originate from Cursor's backend (AWS), not from your machine, so an IP
  allow-list is not practical – the relay token is the access control.

## Limitations

- Prompt assembly still happens in Cursor's backend; only the hop to OpenAI runs on your machine.
- Reasoning summaries and `reasoning.encrypted_content` cannot be returned through Chat Completions
  chunks, so the model does not see its previous reasoning in later turns (answers and tool results
  are preserved).
- The tunnel must not buffer SSE (see the tunnel note in use case 1). ngrok's browser interstitial does
  not affect API traffic.

## Development

```bash
pnpm typecheck   # tsc --noEmit
pnpm start       # node --env-file=.env src/server.ts (Node 24 runs TypeScript directly)
```

No build step, no runtime dependencies besides `@ngrok/ngrok`. All source files live in `src/`.
