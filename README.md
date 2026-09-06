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

Set `LOG_BODIES=1` to attempt diagnostic artifacts in `logs/` sharing one timestamp+id prefix.
Writes are best-effort, limited to 8 MiB per artifact, and may be omitted under I/O failure, a two-second
write timeout, or the four-write global concurrency cap. Truncated artifacts carry an explicit marker.
Directories are owner-only (`0700`), artifacts `0600`, and diagnostic failures do not fail model calls:

| File                       | Content                                                   |
| -------------------------- | --------------------------------------------------------- |
| `1-client-request.json`    | what Cursor sent (Chat Completions shape, tools, prompt)  |
| `2-upstream-request.json`  | what the relay sent to OpenAI (Responses shape, no auth)  |
| `3-upstream-response.sse`  | raw Responses API event stream from OpenAI                |
| `4-client-response.sse`    | Chat Completions chunks returned to Cursor                |

Operational diagnostics and content are separated. The console reports request IDs, upstream status,
conversion state, and replay replacement counts, but does not print upstream error bodies, prompts,
raw history digests, or encrypted payloads. Only `LOG_BODIES=1` writes content; the relay warns at startup.
The upstream-request artifact contains the actual dispatched bytes, including any verified replacements.

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
- Reasoning is not exposed through Chat Completions. The optional local replay cache can restore
  verified original reasoning blocks upstream; without it, only visible history is preserved.
- Replay cannot distinguish every identical visible branch, and scope changes or unobserved traffic
  can cause misses or leave attribution unknowable. No quality, cost, or hit-rate improvement is promised.
- A bounded live `gpt-6-astra` high-effort smoke test verified encrypted replay across restart and
  SSE/JSON transitions on 2026-09-06. This is not a guarantee for month-old ciphertext, large contexts,
  other models, concurrent traffic, or the actual Cursor/ngrok deployment.
- The tunnel must not buffer SSE (see the tunnel note in use case 1). ngrok's browser interstitial does
  not affect API traffic.

## Optional: persistent encrypted reasoning replay

Set `REASONING_CACHE_ENABLED=1` only after validating your model and Cursor configuration. The cache
uses Node's built-in SQLite driver (tested on Node 24.14.1, which emits an experimental warning).
It hashes complete visible message prefixes, including call IDs, and restores whole original output
blocks only when their visible envelope and actual dispatched ancestry verify. It never decrypts
reasoning and never automatically retries an upstream error.

- Default database: `data/reasoning-cache.sqlite`, with an adjacent persistent fingerprint secret.
  Keep the whole directory private. Assistant text and tool arguments are plaintext even though
  reasoning is encrypted. The data directory is excluded from Git.
- Enabled eligible requests use `store: false` and request encrypted reasoning, including cache misses.
  This is not a guarantee of zero provider retention.
- Payloads are reclaimed only after at least 30 idle days and when no retained descendant needs them.
  Conflict/poison markers survive payload reclamation. Quota pressure stops admission, not active-data retention.
  Emergency storage has a 64 KiB minimum. If safety writes cannot be committed, dispatch stops and a
  `.guard` failure latch prevents reopening; do not delete it to bypass the failure.
- Every restart conservatively postpones deletion until 30 trusted days have elapsed. Frequent restarts
  can keep data longer. Clock uncertainty postpones deletion again; replay can continue.
- Disabling an existing cache records an observation gap before serving traffic and retains the exclusive
  store lock until shutdown; an enabled second instance cannot clear the gap while disabled traffic is
  still running. Re-enabling quarantines pre-gap payloads. Never-enabled installations create no database. Do not reuse stores across older
  relay versions that lack this transition guard.
- Stops, failed/incomplete streams, and unresolved crash intents poison the affected prefix position,
  not unrelated histories. Identical visible histories and unobserved generations remain limitations.
- Initial/generation inactivity defaults to 15 minutes and renews on received bytes. Delivery has a
  separate 30-second deadline. Neither is a total lifetime limit on a progressing generation.
- The default 128 MiB cache budget supports up to eight small cached requests concurrently. Admission
  uses measured history size, a bounded capture allowance, and one shared synchronous preparation
  workspace—not 124 MiB per request. Larger requests can reduce the number cached simultaneously.
- **Cache busy means cache bypass, not a failed model call.** Excess requests forward normally without
  replay/capture after a small durable start-position marker prevents stale reasoning reuse there.
  This sacrifices cache continuity at that position, not unrelated histories; later turns can rebuild it.
  `REASONING_CACHE_MAX_CONCURRENT` caps full caching, not relay request concurrency. Bypassed
  calls still receive the relay-wide inactivity and downstream-write deadlines, independently of cache sessions.
  Diagnostics distinguish `memory` from `maxConcurrent` bypasses and report active leases.
- An enabled cache configuration must fit its shared preflight and revalidation workspace before
  the relay starts; an impossibly small budget is a configuration error, not uncapped guard work.
  Reservations are estimates of cache-owned allocations, not a process-wide RSS limit.
- A genuine failure to persist safety metadata still fails closed, reported as HTTP 503
  `relay_cache_unavailable` rather than a misleading upstream-connectivity error. This is different
  from normal cache pressure, which does not reject the request.
- Store JSON parsing remains conservatively bounded. Body-log buffers are created only with
  `LOG_BODIES=1`; ordinary streaming no longer retains both entire SSE streams for disabled logging.
  Existing raw request and JSON-response buffering remain outside the cache-specific memory budget.
- `LOG_BODIES=1` also logs restored payloads. Those logs are independent of cache retention.

All cache controls are documented in `.env.example`; advanced `REASONING_CACHE_HISTORY_MAX_*` and
`REASONING_CACHE_SCRATCH_MAX_BYTES` limits are loaded in `src/reasoning/config.ts`. Changing canonical
limits changes the scope and may make older data unreachable without deleting it.

### Offline backup and restore

From a separate session that does **not** depend on the relay, stop the owning process first.
The administration command refuses an active owner and never overwrites a destination:

```bash
pnpm cache:admin backup data/reasoning-cache.sqlite private-backup/cache.sqlite
pnpm cache:admin restore private-backup/cache.sqlite recovered/cache.sqlite
```

Both operations preserve the adjacent secret and mark an observation gap so even direct activation
of a backup quarantines pre-snapshot payloads; a new 30-trusted-day deletion barrier applies.
A durable `.blocked` marker prevents opening a destination if snapshot publication is interrupted.
Do not remove `.blocked` or a latched `.guard` to bypass a failed recovery. Select the restored path
explicitly in configuration only during a separately authorized cutover. A backup cannot reconstruct
observations made after its snapshot. Keep backup/recovery directories out of Git and private.

### Offline validation and safe rollout

```bash
pnpm typecheck
pnpm test        # synthetic fixtures, temporary databases, fake upstreams, concurrency 1
```

Do not test a new branch by changing the checkout that serves your current agent session. Use a
separate worktree with its own dependencies and synthetic configuration. Tests do not load `.env`
or start ngrok; all servers use ephemeral loopback ports. Live provider tests and any deployment
switchover require separate authorization and a session that does not rely on the relay being replaced.

### Explicitly authorized live smoke test

`tests/live-smoke.ts` is deliberately excluded from `pnpm test`. It reads only the OpenAI key from an
explicit key file, uses an independent relay token and OS-assigned loopback port, and never starts
ngrok or changes the serving checkout. Four calls are capped at 4,096 output tokens each; API usage
is billable. It saves private synthetic request/response logs and a redacted `summary.json` under a
new `/tmp/openai-replay-live-*` directory and stops its listeners in `finally`.

```bash
ALLOW_BILLABLE_REPLAY_SMOKE=1 REPLAY_SMOKE_KEY_FILE=/absolute/path/to/key.env node tests/live-smoke.ts
```

The first live run found that OpenAI can supply different encrypted bytes for the same reasoning
item in `output_item.done` and `response.completed`. The completed ciphertext is now authoritative
only when all non-ciphertext fields match. The corrected run verified one exact original block
accepted after restart and two exact original blocks accepted on the following streaming request.
The initial simple tool call produced no reasoning item; it was correctly not admitted as a payload.

### Concurrent-request validation

The simplified policy was verified with eight overlapping requests against a fake upstream, then
four real `gpt-6-astra-high` calls on an isolated loopback listener. Two concurrent live requests both
used caching; with full-cache concurrency forced to one, the second request bypassed caching and
both still returned HTTP 200 with correct streamed answers. No test listener or tunnel was left running.
A 5.69 MiB synthetic tool history also completed offline; this is not an exhaustive load benchmark.

`tests/live-concurrency.ts` uses the same explicit billable opt-in and key-file variables as the smoke
test. It is excluded from the automatic test suite. The actual Cursor/ngrok cutover remains a separate
operator-controlled action; these tests never change routing or restart the serving relay.

### Broader real-service acceptance (2026-09-06)

`tests/live-acceptance.ts` runs 20 explicitly authorized generation requests against isolated
loopback listeners and the real OpenAI service. `tests/live-acceptance-recheck.ts` exercises token
exhaustion/cancellation; `tests/live-acceptance-extended.ts` covers concurrent restart replay,
identical-visible-answer ambiguity, observe-only competitors, and a roughly 24k-input-token context.
All are excluded from `pnpm test` and require the same explicit billable opt-in/key-file variables.

The latest full run passed all 21 checks. Focused extensions passed after correcting two test
assumptions (unsupported Astra effort `none`, and a miscomputed fixture expectation). The first
run also exposed a relay bug: JSON token exhaustion was reported as `stop`; it now correctly
returns `length`. Incomplete/error SSE terminals poison cache state without prematurely aborting
terminal delivery. Cancellation was tested both after visible text and during reasoning, with
zero active sessions/intents verified before shutdown.

The exercise attempted 64 generation requests, including rejected/canceled calls and reruns.
No serving checkout, tunnel, or Cursor routing was modified. All owned listeners were closed.
The local suite passes 128 tests. Power-loss durability, month-old ciphertext, sustained load,
and an actual Cursor/tunnel cutover are not established by these live checks; use a controlled
switchover with a rollback path rather than treating acceptance as a no-failure guarantee.

### Deeper adversarial round (2026-09-06)

A subsequent round attempted 152 real requests, including focused rechecks and one direct-provider
image comparison. The corrected deep suite passed 24 scenario groups across 64 requests: four
five-turn conversations with restarts, ten-way concurrency under a two-slot cache, Unicode tool
arguments, three tool rounds, cache-isolation mutations, identical-answer ambiguity, actual partial
tool-argument truncation, repeated cancellation, and capacity/quota fallbacks. The final four-call
replay smoke passed after protocol fixes. The offline suite now has 150 passing tests.

Fault injection uncovered and fixed three boundary problems: malformed generation bodies now
return local 400 errors rather than mapper failures; broken/missing-terminal SSE fails transport
rather than ending HTTP successfully; failed/nonterminal JSON responses cannot masquerade as
successful empty Chat answers. Synthetic upstreams cover 429/500, failed streams, malformed SSE,
socket resets, and inactivity deadlines without trying to cause real provider outages.

**Unresolved:** a positive solid-red PNG interpretation check returned incorrect/imprecise colors,
including when the same input bypassed the relay and went directly to OpenAI. Conversion input
matched exactly, but the cause of that synthetic-image anomaly is not established. A later ordinary-photo comparison and exact-choice controls passed (see below); the earlier failure is retained as evidence, not treated as a general failure of image forwarding.
No suite covers every possible edge case or replaces a real Cursor/tunnel canary and sustained-load
monitoring. All temporary test listeners were stopped and the serving checkout was untouched.

### Transport and diagnostics hardening after the delayed audit

Additional local regressions cover bodyless HEAD/204 passthrough, uncached-request timeouts,
per-write backpressure deadlines, uploads/event/JSON size ceilings, post-DONE suppression, and
private nonfatal logging. Explicit `store:false` and `include` survive disabled/observe-only/bypassed
Chat translation. Refusal-only JSON preserves its refusal text. Missing/invalid message roles and
malformed tool shapes return local 400 rather than acquiring mapper defaults.

Transport defaults apply independently of caching: 64 MiB requests, 64 MiB buffered JSON/error
responses, 8 MiB per SSE event, 15-minute upstream inactivity and 30-second delivery/write deadlines.
Configure `RELAY_MAX_REQUEST_BYTES`, `RELAY_MAX_RESPONSE_BYTES`, `RELAY_MAX_SSE_EVENT_BYTES`,
`RELAY_IDLE_TIMEOUT_MS`, and `RELAY_DELIVERY_TIMEOUT_MS` for legitimate larger workloads. Oversized
requests get HTTP 413; broken/oversized upstream streams fail rather than silently succeeding.
These are per-request/operation bounds, not a global process RSS guarantee. Cache size limits do
not substitute for transport limits.

A final 20-request live acceptance rerun passed all 21 checks on this transport-hardened code,
bringing the deeper exercise to 172 requests. The current offline suite passes 193 tests. All
owned test listeners were stopped, and no serving process or routing was changed. The positive
image-interpretation limitation above remains unresolved.

### Ordinary photo and exact-choice visual checks (2026-09-06)

Three fixed JPEGs from [Lorem Picsum](https://picsum.photos/) (IDs 237, 1025 and 10) were sent as
inline image data, with identical request bodies compared through the isolated relay and directly
to OpenAI. All six descriptions correctly identified the two dogs and the forest/water landscape.
The forwarded image bytes were identical to the downloaded fixtures.

A subsequent exact-choice test used shuffled answer positions, neutral identifiers, and a no-image
control. All ten answers (five relay, five direct) matched the required single uppercase letter
exactly—no trimming or substring scoring. The no-image case correctly chose cannot-determine.
This validates broad photo classification for these fixtures, not general OCR, screenshot accuracy,
or the cause of the earlier tiny flat-color PNG anomaly. Harnesses `tests/live-picsum.ts` and
`tests/live-image-choice.ts` are manual, billable opt-ins and never run under `pnpm test`.

## Inspecting a running relay safely

Enable the **private Unix-domain admin socket** in the relay's environment:

```bash
RELAY_ADMIN_SOCKET=data/admin/relay-admin.sock
```

This takes effect on the next planned startup. Do not restart the relay serving an agent session
from that dependent session. The existing OpenAI/ngrok listener does not expose admin routes.
Unix filesystem permissions authenticate local access: the socket directory is private and the
socket is `0600`. Processes running as the same account are trusted. An existing socket/path is
not overwritten or unlinked automatically; resolve stale sockets only after confirming no owner
is using them.

From the repository directory, using the same OS account:

```bash
pnpm cache:admin status
pnpm cache:admin status --json
pnpm cache:admin snapshot
# Custom paths can be supplied without loading the relay's credentials:
pnpm cache:admin status --socket /absolute/private/path/relay.sock --json
```

The CLI defaults to `data/admin/relay-admin.sock`, or the `RELAY_ADMIN_SOCKET` environment variable.
It does not load `.env` or require an OpenAI key. Use `--socket` if the server's custom `.env` path
is not exported in your terminal.

Status uses the owner's existing SQLite connection and runtime counters. It does not touch
payload timestamps, renew intents, expire records, checkpoint the WAL, or load prompts/ciphertext.
Database aggregate counts are bounded and briefly cached; results label limited counts rather
than claiming a complete scan. Runtime counters are process-local and dispatched replay is not
a provider-acceptance measurement.

`snapshot` asks the owner to use SQLite's online backup API, copying in small page batches while
normal requests can continue. Only one snapshot runs at a time, disk capacity is checked, and the
source connection stays open until copying settles. The completed file path is returned only
after successful publication. Inspect that **copy**, never bypass locks on the live database:

```bash
sqlite3 -readonly 'file:/path/returned/by/snapshot.sqlite?immutable=1' 'SELECT count(*) FROM payloads;'
```

Use `immutable=1` only on the completed, stable export—not on the changing live database or a
hand-copied live WAL. It prevents the inspection connection from creating WAL/SHM sidecars.

Inspection copies default to `~/.openai-relay-inspection/<generated-id>/snapshot.sqlite`; set
`RELAY_ADMIN_SNAPSHOT_DIR` to another private directory if needed. They are created outside the
checkout by default so group-writable development directories need not have their permissions
changed. Export ancestors must be real, trusted, non-writable-by-others directories (a root-owned
sticky `/tmp` ancestor is permitted); the export root and generated child are `0700`. Unsafe paths
are rejected, never repaired automatically. A configured path is server-side policy, not an API argument.

Completed copies are owner-read-only (`0400`) and omit the cache secret. They contain sensitive
assistant/tool output and encrypted reasoning, and are **not** activation/recovery backups. They
are not automatically activated, deleted, or restored. Existing snapshots remain intact when
another is created, including after restart; remove copies you no longer need manually.
Use the separate offline backup/restore workflow for recovery.

A copy uses 32-page batches, requires at least 64 MiB of remaining filesystem capacity beyond
estimated copying needs, and currently declines sources above 256 MiB including database/WAL/SHM
storage. Capacity is checked during copying too. A failed copy cleans up only its own private
partial directory and does not poison the live cache. Status remains useful when a snapshot is
declined. The defaults are safety limits, not performance claims.

Snapshot I/O has a cost; it is not a promise of zero latency impact or a substitute for load
testing. The admin socket accepts fixed status/snapshot operations only, not arbitrary SQL or
caller-supplied destination paths. No LLM calls are made by administration.

### Pre-merge live administration check

`tests/live-admin.ts` is an explicitly authorized five-call live harness, excluded from `pnpm test`.
It uses its own loopback listener, private admin socket, cache, export directory, synthetic invoice
history and logs; it never starts ngrok or changes the serving checkout. It loads only the key from
`REPLAY_SMOKE_KEY_FILE` when `ALLOW_BILLABLE_REPLAY_SMOKE=1` is explicitly set.

The 2026-09-06 run passed all six acceptance checks: status/CLI refresh without source-state changes,
a snapshot completed while two real generations remained active, correct concurrent replies,
continued exact encrypted-block replay, a second snapshot preserving the first, and no unauthenticated
admin data from the public listener. Both copies passed integrity/foreign-key checks, were `0400`,
and had no secret. Final live status had zero sessions/intents and no request or preparation failures.
All test-owned listeners were stopped. Snapshot duration was 58 ms for this small test database;
this does not establish performance for large production stores. Deployment still requires a separate
planned restart and a check of the actual admin socket afterward.

## Development

```bash
pnpm typecheck   # tsc --noEmit
pnpm test
pnpm start       # starts the configured relay and possibly ngrok; not a test command
```

No build step or added database dependency. The server factory in `src/app.ts` is importable without
loading `.env`, binding a port, or starting a tunnel.
