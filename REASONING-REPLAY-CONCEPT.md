# Encrypted reasoning replay

Revision 12 — implementation including optional private local administration, 2026-09-06.

## Purpose

Cursor sends visible conversation history using Chat Completions. The relay translates it to OpenAI's Responses API, which can also accept encrypted reasoning from previous responses.

The replay cache preserves that reasoning locally. When a later request contains the matching visible conversation, the relay replaces verified assistant messages with their original Responses output blocks, including encrypted reasoning. Cursor continues receiving ordinary Chat Completions responses.

The relay never decrypts reasoning. It treats encrypted content as opaque, sensitive state.

## 1. Request flow

1. Authenticate and validate the incoming request.
2. Resolve the model alias and translate the request to Responses format.
3. Build a cache scope from the effective outbound configuration and hash the original visible history.
4. Find and validate cached output blocks that match complete assistant messages.
5. Reconstruct upstream input with any verified replacements.
6. Commit an in-flight intent and revalidate the selected blocks immediately before forwarding.
7. Stream or return the ordinary converted response to Cursor while collecting output for observation and possible caching.
8. Commit the completed observation before sending terminal output; resolve its intent after successful local delivery.

A cache miss uses ordinary visible-history translation. Eligible cached requests use `store:false` and include `reasoning.encrypted_content`, even on a miss. There are no automatic upstream retries.

## 2. Matching visible history

### Scope

A cache scope separates requests whose effective model context differs. It includes:

- Identity format version and canonicalization limits.
- Upstream origin and actual endpoint.
- HMAC fingerprints of the OpenAI credential, relay token and caller value, using a persistent cache-local secret.
- Resolved model, effective reasoning settings, tools, output limits and other translated configuration.
- Effective `openai-beta` header.
- Effective `store:false` and merged, deduplicated include selections.

Raw credentials are not stored. Caller values partition the cache but are not authentication. Transport details such as `stream` do not distinguish otherwise matching histories.

### Canonical messages

The relay hashes complete Chat message envelopes, not flattened Responses input items. Tool-call IDs are ordinary hashed content; there is no separate tool-ID lookup.

Canonical JSON preserves array order and uses deterministic object-key ordering and JSON escaping. Assistant messages normalize these equivalent forms:

- Text strings and arrays of exact text parts become the same concatenated text.
- Absent, null or empty content becomes empty text.
- Absent `tool_calls` and an empty array are equivalent.
- A redundant tool-call `index` matching its array position is omitted.

Unknown nested fields remain hashed and can make a request ineligible for replay. User/tool string-versus-parts distinctions remain intact. Tool-message `name` remains hashed even though translation drops it. Incoming tool-argument strings are not parsed or reformatted during history hashing.

### Prefix hashes

One SHA-256 state starts with a domain tag and framed canonical scope. Each complete canonical message is appended with an unsigned 64-bit big-endian UTF-8 length prefix. The relay records the digest at each message boundary.

A cached block has:

- `startDigest`: visible history immediately before its assistant message.
- `endDigest`: visible history including that complete assistant message.
- An independent fingerprint of the canonical assistant envelope.

Matching uses `endDigest`, then verifies the start boundary and envelope. A text prefix or partial set of tool calls cannot match a larger assistant message.

Canonical byte lengths and structural limits are measured before emission and key sorting. Scope and history share one byte budget. The serializer emits bounded chunks instead of building a complete canonical-history string. Capture retains the final hash state so it can calculate an output block's end digest.

## 3. Replay blocks and ancestry

Each admitted record retains the complete original ordered `response.output`: reasoning items, assistant messages with their original fields, and function calls. The record also contains its payload fingerprint, generation, snapshot, producing intent ID and **the exact earlier replay plan dispatched when it was generated**.

The planner starts with the newest matching record. Its proposed plan is that record's recorded ancestors followed by the record itself. Every ancestor must be present, match its fingerprint and position, and have the expected preceding plan.

Validation checks:

- Complete visible-envelope match.
- Current scope generation and persisted record identity.
- No applicable poison or conflict marker.
- Consistent ordered ancestry and call/result sequence.
- No competing unresolved generation at a selected block's start position, except the block's own producing intent.
- Accepted model snapshot for the record determining the plan.

If a plan is invalid or exceeds its budget, the planner tries an older coherent plan or sends no replay. It never inserts an earlier block beneath a descendant generated without it.

Each selected assistant envelope is replaced exactly once with its original output block. Current user messages and tool results are preserved. All matching hashes still refer to the unmodified visible history.

Immediately before transport, a synchronous SQLite transaction revalidates the complete plan, touches and pins its dependencies, and creates a `dispatch` intent. Forwarding starts without an intervening `await`. A later conflict cannot recall a request already sent.

## 4. Capture and conflict handling

Capture collects original finalized output items and the actual converted client frames or JSON object separately. At completion it checks that the original block projects to the output sent to Cursor.

The completed response's reasoning ciphertext is authoritative. OpenAI may supply different encrypted bytes in `output_item.done` and `response.completed` for the same reasoning item. That difference is accepted only when both ciphertexts are nonempty, the IDs match, and every other item field is equal.

Capture predicts Cursor's next assistant envelope using the same message normalization. Tool arguments are parsed and reserialized on this capture side. Numerically unsafe or changed number spellings, such as unsafe integers, `1.0`, exponents or `-0`, are rejected conservatively. An unknown prediction causes non-admission or position poisoning rather than guessed matching.

A payload is admitted only for a complete supported response with nonempty encrypted reasoning and a nonempty visible envelope. Refusals, unsupported output and reasoning-free completions still participate in observation when their identity is known.

Observation happens before deciding whether a payload fits:

- Same visible identity and matching payload/provenance is repeatable observation.
- Different payload or provenance for that identity creates an `end-conflict` marker.
- Unknown or interrupted output creates a `start-poison` marker covering every possible assistant envelope at that position.

Markers apply across scope generations. They survive payload deletion and prevent an old ambiguous position from becoming reusable merely because its data was reclaimed.

Completed observation, any admitted payload and dependencies, and the transition to `delivery` are committed before terminal frames or completed JSON are sent. Local `finish` resolves the intent. Request resources are released after both request handling and the delivery lifecycle end.

Failed/incomplete output or capture exhaustion poisons the cache position without preventing delivery of an otherwise valid response. Broken upstream transport fails explicitly. Startup poisons and removes all unresolved intents left by an earlier process.

## 5. Capacity fallback

Caching is optional under normal memory or concurrency pressure.

The runtime accounts for one shared synchronous preparation/validation workspace and per-session allowances based on measured history size, capture capacity and replay overhead. If a request cannot acquire a cache session:

1. Commit `start-poison` for its generated position.
2. Forward the ordinary translated request without replay, capture or an intent.

The marker prevents this unobserved generation from leaving an older record falsely unique. Unrelated histories remain usable, and later positions can build new replay chains. `REASONING_CACHE_MAX_CONCURRENT` therefore limits full caching, not model-call concurrency.

If the safety marker cannot be persisted, the relay returns cache-unavailable HTTP 503 instead of forwarding unsafely. Deterministic canonical-limit refusals are different: the versioned limits give the same scoped history the same decision, so those requests skip caching without an intent or marker.

Explicit caller `store` and `include` values survive disabled, observe-only and capacity-bypassed translation. Eligible cached requests override storage to false and merge the reasoning include.

## 6. Persistent storage

SQLite is authoritative. One process holds an exclusive connection, verified by a startup write. The store uses WAL, foreign keys and `synchronous=FULL`.

The schema separates:

- **Scopes:** identity, generation, model/caller targeting and latest snapshot.
- **Observations:** start/end digests, envelope and payload fingerprints, exact output hash, JSON prior plan, producing intent, snapshot and replayability.
- **Payloads:** original output JSON, serialized size and `touched_at`.
- **Markers:** generation-independent `start-poison` and `end-conflict` rows.
- **Dependencies:** retained ancestry and active intent pins.
- **Intents:** `dispatch` or `delivery` phase, start position, actual prior plan and deadline metadata.

Other non-admission state uses the observation's `replayable` field. Digests and plan descriptors are hex strings stored in JSON, not packed binary records. Producing intent IDs remain as non-FK values after intents are deleted.

Stored lengths and estimated parsed-memory costs are checked before loading JSON. Ancestry validation deduplicates records before loading. The bounded hot cache holds immutable objects and checks persisted row versions; eviction changes no durable knowledge.

The snapshot heuristic accepts the latest observed snapshot or one observed within the last 24 hours. Earlier blocks inherit the acceptance represented by the newest record determining the plan. This reduces incompatible replay attempts but cannot guarantee provider acceptance of old ciphertext.

### Retention and cleanup

Payloads have a sliding idle window of at least 30 days. Qualifying touches update `payloads.touched_at` using `max(existing, now)` when matching retained records are actually inspected and validated, selected for dispatch, or referenced/observed during publication. Ambiguous or poisoned records may be touched without becoming replayable. Requests that bypass before planning do not touch every potential history match.

Every startup begins a separate **fixed 30-day monotonic deletion barrier**. Detected backward clock movement or wall/monotonic drift over 60 seconds resets that barrier. The configured idle-age cutoff still applies independently; a 60-day retention setting requires 60-day-old payloads, with a 30-day restart barrier. Clock tracking is process-local, so each restart starts the barrier again.

Hourly cleanup deletes at most 100 eligible payloads, descendants before ancestors. Active intent dependencies, same-position competitors and retained descendants prevent reclamation. Observations and markers are retained indefinitely. Frequent restarts can intentionally cause overretention; replay remains available during the deletion barrier.

Disk pressure stops payload admission rather than deleting active data. A physically allocated reserve supports safety writes; capacity/I/O failure may release it and retry the local transaction once. Repeated safety failure latches `.guard` and blocks store reuse. This local retry never resends a model request.

## 7. Enable/disable, restart and backups

`REASONING_CACHE_ENABLED` is read at startup:

- `1`: enable caching and replay.
- `0` or unset: disable them.

With no existing store, disabled startup creates no cache artifacts. With an existing store, disabled startup acquires ownership, performs recovery, writes `coverage-gap=1`, and keeps the exclusive lock while serving unobserved traffic. It does no per-request cache work.

On the next open, a recorded gap advances all existing scope generations and is consumed transactionally, retaining payloads and markers. A continuously enabled restart without a gap does not rotate generations. Unresolved intents are recovered on every startup.

Direct Responses or otherwise underivable generation traffic fences matching existing scopes: credential/model/caller when the caller is available, otherwise credential/model. Fencing poisons affected unresolved positions and advances generations. It protects existing records but cannot reconstruct output generated on unobserved paths.

Both offline admin commands, `backup` and `restore`, create a new snapshot with its secret and `coverage-gap=1`. Neither overwrites or activates a destination. A `.blocked` file prevents activation until snapshot publication and metadata are durable. Opening either snapshot quarantines pre-snapshot generations and starts the usual retention barrier.

Shutdown stops new work, aborts and poisons active sessions, closes connections and then closes the store. A running process does not reload new source or `.env` values. Deployment or restart must be performed separately from a session that relies on the relay itself.

## 8. Timeouts, transport and diagnostics

Cache generation deadlines use a monotonic clock and renew on progress; default inactivity is **15 minutes**. In-memory revision checks ignore stale timer callbacks. Persisted intent deadlines are coalesced diagnostic metadata, updated no more often than once per `min(5 seconds, idle timeout / 4)`. Startup recovery does not try to resume those timers.

After completion, delivery has a separate **fixed 30-second deadline**. Each blocked client write also has its own backpressure deadline. Healthy upstream progress can keep a generation alive beyond its initial deadline; it does not extend completed-response delivery indefinitely.

Independent relay transport guards cover cached, disabled, bypassed and passthrough requests. They handle upload/upstream inactivity, downstream backpressure, bodyless responses and size limits. SSE stops at its first terminal event; malformed or missing-terminal streams fail transport. JSON token exhaustion reports `length`; refusals remain visible; failed/nonterminal JSON cannot become successful empty answers.

Diagnostics are separate from the safety ledger. Logs report skips, memory/concurrency bypasses, active leases, dispatched replacement counts and failures without printing raw history, credentials or ciphertext by default. A dispatched replacement is not an upstream acceptance measurement.

With `LOG_BODIES=1`, diagnostic content is sensitive and written best-effort:

- 8 MiB payload limit per artifact, followed by a truncation marker when needed.
- At most two seconds waiting per write and four outstanding writes globally.
- No unbounded queue or retry; failure disables that writer with a sanitized warning.
- Owner-only directories (`0700`) and files (`0600`), with traversal/static-symlink rejection.

Diagnostic failures do not intentionally fail model calls. Logs may be incomplete and are not governed by cache retention.

## 9. Configuration and effective limits

Defaults from `src/reasoning/config.ts`:

- Cache disabled; database `data/reasoning-cache.sqlite`; idle retention 30 days.
- Overall cache-accounting budget **128 MiB**; disk admission 1 GiB; reserve 64 MiB, with a 64 KiB minimum.
- Entry/capture allowance 4 MiB; configured replay ceiling 16 MiB; plan limit 256 records; full-cache concurrency 8.
- Combined canonical scope/history budget 32 MiB; 6,400 messages; 2,000,000 nodes; depth 64; 4,000 candidate lookups; 16 MiB scratch.
- Generation inactivity 900,000 ms; fixed delivery 30,000 ms.

The 128 MiB setting is not the hot-cache size. With memory budget `M`, configured replay bytes `R`, entry allowance `E`, scratch `S` and measured canonical bytes `C`:

- Hot cache `H = min(4 MiB, floor(M / 32))`.
- Replay workspace `W = min(R, floor(M / 16))`.
- Shared reservation `H + S + 2W`.
- Session allowance `64 KiB + 2E + 2C + W / 8`.

At defaults, shared accounting is **36 MiB**, leaving 92 MiB for sessions. Small requests can fit eight cached sessions. An enabled configuration unable to fit shared work plus 64 KiB fails startup.

**Effective store-validation ceiling:** runtime supplies `floor(W / 32)` serialized payload bytes to account for conservative 32× parsing expansion. This is **256 KiB by default**, with metadata/plan charges able to constrain it further. The 16 MiB configured replay ceiling is therefore not the effective default readable-plan size. Increasing only that setting may not increase the allowance because memory also bounds `W`.

Planner search is sequential and bounded by `maxPlanRecords * 4` verification work. Cache-state-dependent budget exhaustion falls back to no replay while retaining observation; it is not an intent-less deterministic skip.

Independent transport defaults:

- `RELAY_MAX_REQUEST_BYTES=67108864`: 64 MiB upload limit; overflow receives 413.
- `RELAY_MAX_RESPONSE_BYTES=67108864`: 64 MiB for buffered JSON/error responses.
- `RELAY_MAX_SSE_EVENT_BYTES=8388608`: 8 MiB per SSE event.
- `RELAY_IDLE_TIMEOUT_MS=900000` and `RELAY_DELIVERY_TIMEOUT_MS=30000`; absent overrides use cache timeout settings.

These are operation/allocation budgets, not a global RSS bound. Transport buffers, diagnostic buffers and request concurrency are separate from optional cache accounting. Changing deterministic canonical limits changes cache scope and can make older entries unreachable without deleting them.

## 10. What the checks establish

The recorded implementation validation passed **193 offline tests**, typechecking and whitespace checks. Tests cover canonical identity, capture, ancestry, ambiguity, persistence, restart/disabled gaps, injected clocks and storage faults, quotas, concurrency fallback, transport errors/timeouts, validation and private bounded logging.

Authorized live runs verified exact encrypted output blocks accepted after restart, JSON/SSE transitions, tool chains, concurrent conversations, history/configuration isolation, ambiguous regenerations, cancellation, token limits and quota fallback. The final full live acceptance run passed **21 checks across 20 requests** on the transport-hardened code.

Three fixed JPEGs from [Lorem Picsum](https://picsum.photos/) were correctly described through both the relay and exact-body direct OpenAI calls. Shuffled exact-choice classification and a no-image control produced **10/10 exact answers**. These checks support image forwarding and broad classification for those fixtures, not general screenshot/OCR accuracy. A tiny flat-color PNG anomaly also occurred directly against OpenAI and remains unexplained.

The tests do not prove every model/provider behavior, month-old ciphertext compatibility, physical power-loss recovery, sustained production load, or an actual Cursor/tunnel deployment. Identical visible histories and unobserved or scope-changed generations can remain indistinguishable. Local `finish` proves local delivery, not receipt beyond the relay socket.

## 11. Live local inspection

An optional `RELAY_ADMIN_SOCKET` enables a separate Unix-domain listener. It is not part of the
public HTTP server and cannot be reached through the configured ngrok tunnel. Access is limited
by a private directory and owner-only socket permissions; there is no arbitrary SQL or
caller-selected snapshot destination.

`pnpm cache:admin status` requests runtime and database metadata through the owner's existing
connection. Runtime counters start at process startup and distinguish dispatched replay from
provider HTTP success. Database aggregates scan a bounded number of rows, report exact or
lower-bound values, and are cached for five seconds. Inspection does not touch payloads, renew
intents, reset retention clocks, checkpoint the WAL, or run cleanup. Retention information is
reported from its last validated sample rather than advancing clock state for an admin poll.

`pnpm cache:admin snapshot` uses Node's SQLite online backup API through that same source
connection. Only one copy runs at a time. It copies in page batches into a private generated
inspection path after capacity checks; publication occurs only on successful completion.
Inspection exports omit the cache secret and are not activation/recovery backups. They default
to a private `~/.openai-relay-inspection` directory (overridable with `RELAY_ADMIN_SNAPSHOT_DIR`),
use owner-read-only completed files, and preserve earlier snapshots until manually removed.
Copies run in 32-page batches with a 64 MiB free-space margin and a 256 MiB source-size ceiling.
They contain sensitive payloads and must remain private. Shutdown waits for any pending backup before closing
SQLite; a disconnected admin client does not grant permission to close a still-used handle.

The socket is opt-in at startup, so installing this code does not alter an already-running relay.
The existing offline `backup` and `restore` commands retain their separate recovery semantics.

An isolated five-call real-OpenAI check verified metadata reads without source-row/touch changes,
a consistent snapshot during two ongoing generations, and continued exact-block replay afterward.
Snapshots were checked separately for integrity, privacy and secret omission; the earlier export
survived the next copy. The test ended with no active sessions/intents. It did not deploy this
interface to the serving relay or establish large-store snapshot latency.

## 12. Code locations

- Request orchestration and validation: `src/app.ts`, `requestHandler.ts`, `requestValidation.ts`, `http.ts`.
- Alias and visible translation: `modelAlias.ts`, `rewrite.ts`, `chatToResponses.ts`, `chatMessages.ts`.
- Identity/scope: `src/reasoning/canonical*.ts`, `identity.ts`, `identityScope.ts`, `eligibility*.ts`.
- Admission/planning: `src/reasoning/admission.ts`, `planner.ts`, `runtime.ts`.
- Persistence and recovery: `src/reasoning/store*.ts`, `resources.ts`, `retention.ts`, `backup.ts`, `admin.ts`.
- Capture/session lifecycle: `src/reasoning/capture.ts`, `session.ts`, `lifecycle.ts`.
- Transport/output: `transport.ts`, `clientWrite.ts`, `progressBody.ts`, `sse.ts`, `relayResponse.ts`, converters and `responsesTypes.ts`.
- Diagnostics and process lifecycle: `log.ts`, `server.ts`, `tunnel.ts`.
- Private local administration: `src/admin/`, `src/reasoning/inspection*.ts`, `metrics.ts`, and `admin.ts`.
- Automatic regression tests: `tests/*.test.ts`. Live harnesses are manual opt-ins and do not run under `pnpm test`.
