# Encrypted reasoning replay: concept

Revision: 10 — implementation contract incorporating the four latest review fixes after revision 9.
Status: **implemented on the isolated update/encrypted-reasoning-replay branch; sequential live OpenAI smoke test passed on 2026-09-06; broader release gates remain pending**. Historical design reviews do not provide blanket implementation approval. The authorized live smoke test used synthetic invoice data, real `gpt-6-astra` high-effort calls, isolated loopback listeners, and a private temporary cache. It verified original encrypted blocks being replayed and accepted across restart and streaming/JSON transitions. Follow-up validation covered eight overlapping offline requests, a 5.69 MiB synthetic history, and two pairs of concurrent live calls including forced cache-capacity fallback. Real Cursor UI routing, tunnel cutover, and sustained production load remain untested.

### Implementation validation and conservative choices

- Delayed transport audit follow-up: transport watchdogs now protect cached, disabled, bypassed and passthrough requests alike. Bodyless responses terminate, all forwarding honors bounded write backpressure, SSE processing stops at its first terminal, and upload/event/JSON buffers have separate configurable ceilings. Explicit caller storage/include controls survive cache bypass. Refusal-only JSON remains visible. Diagnostic buffers/writes are capped, private and best-effort. These protocol fixes are validated by 193 offline tests and a final 21-check/20-request live suite; the unresolved positive image interpretation case and actual Cursor/tunnel cutover remain excluded from a blanket approval.

- `pnpm typecheck`, `pnpm test` and `git diff --check` pass in the isolated worktree. The offline suite uses synthetic SSE/JSON, fake upstreams, temporary SQLite databases, injected clocks and process-crash fixtures. This is not live protocol or empirical hit-rate validation.
- An existing-store disabled runtime holds its exclusive SQLite lock for its lifetime, not merely while writing the gap. Maintenance and replay stay disabled; re-enable is possible only after that owner stops.
- Ancestry validation deduplicates before loading, checks stored JSON lengths before parsing, and charges conservative parsed expansion. Immutable hot entries are checked against persisted row versions. Bounded plan work may fall back to no replay without skipping the durable intent or observation.
- Active intent expiry is controlled by monotonic generation/delivery watchdogs, not by another request comparing wall-clock deadlines. Unconditional durable-intent recovery is reserved for startup.
- Backup and restore destinations remain blocked until data, secret and coverage-gap state are durably published. Both forms of snapshot are fenced on activation; no automatic cutover occurs.
- Resource policy simplified after the initial live test: one shared synchronous preflight/validation workspace, plus per-session allowances based on measured history and bounded capture, replace the fixed 124 MiB reservation. Defaults admit eight small cached requests concurrently. Capacity exhaustion durably poisons only the generated start position before ordinary uncached forwarding, retaining no capture/intent for that bypass. Thus an unobserved competitor cannot leave a record falsely unique; unrelated requests and later positions continue. Failure to persist that marker returns explicit HTTP 503. `maxConcurrent` limits full caching, not model-call concurrency.
- With body logging off, whole SSE streams are no longer retained merely for a no-op log write; durable progress renewals are coalesced instead of fsyncing every fragment. Cache size accounting remains distinct from existing raw-request/JSON-response buffers.
- The SQLite observation row's durable `replayable` state also represents nonreplayable identity state; start-poison and end-conflict use separate typed markers. Whole identity observations and conflict knowledge survive payload cleanup.
- Live validation initially exposed different `encrypted_content` values between `response.output_item.done` and `response.completed` for the same reasoning item. Capture now trusts the completed ciphertext only when both items are reasoning, IDs match, both ciphertexts are nonempty, and all other fields match exactly. Changes to IDs, summaries, visible text, or tool arguments still fail reconciliation. A synthetic regression reproduces this event-shape difference without retaining real ciphertext in the repository.
- After that fix, four sequential real-OpenAI calls passed: tool call, tool-result streaming answer, post-restart JSON answer with one exact original encrypted block, and streaming follow-up with two exact original blocks. The test cache ended with two replayable payloads, zero markers, and zero unresolved intents; its listeners were stopped. No live-serving checkout, tunnel, or Cursor routing was changed.
- Simplified admission validation: eight cached offline requests overlapped; with full caching limited to two, all eight still succeeded and six durably marked their own start positions before bypassing. A 5.69 MiB synthetic history succeeded. Four subsequent real-OpenAI calls verified two concurrent fully cached requests, then one cached plus one capacity-bypassed request, all HTTP 200/correct with no unresolved intents. Capture-budget failure also no longer aborts an otherwise valid completed client answer.
- Broader live acceptance subsequently attempted 64 generation requests (including canceled/rejected requests and reruns). The corrected full suite passed all 21 checks; focused extensions verified four concurrent replays after restart, identical-visible-output ambiguity, observe-only competing generations, real cancellation during reasoning/after text, and ~24k-token synthetic-context replay. The first run exposed JSON token exhaustion being mislabeled `stop`; it now maps to `length`, and failed/incomplete stream terminals no longer abort transport before delivery. Unsupported effort `none` and an incorrect arithmetic expectation were test-fixture issues, corrected separately. Every test store ended with zero unresolved intents and all test listeners were closed. These are not tests of a real Cursor/tunnel cutover or sustained load.
- Operator action is still required for an authorized real-Cursor fixture corpus, sustained load and quantitative hit-rate measurement, and any deployment switchover.

## 1. Objective and decisions

Preserve OpenAI's opaque encrypted reasoning across Cursor Agent tool continuations and later user turns, without changing Cursor or exposing reasoning through Chat Completions.

The relay caches complete original Responses output blocks. It restores a block only when the current visible history verifies the block's location and emitted output, and the selected earlier hidden blocks agree with the provenance under which it was generated.

Use **one content-addressed lookup mechanism: incremental hashes of complete canonical visible-message prefixes**. Tool-call IDs are ordinary hashed content. There is no tool-ID index, inferred conversation ID, fuzzy matching, or mutable last-response pointer.

A miss preserves ordinary visible-history translation; eligible requests in the opt-in mode additionally use stateless upstream controls. Wrong-context replay is worse than a miss — but a cache that is permanently inert or self-disabling on routine events is not a deliverable either. Version one must produce verified hits on recorded real Cursor sessions (section 15, test 1) and every field observed in the recorded corpus must be classified (test 3).

Decisions:

- Opt-in, single-owner SQLite storage surviving clean relay restarts, with a bounded in-memory hot cache; no debugging-log import. Disabled mode never creates a store for a never-enabled installation, but an existing store requires a durable metadata-only disabled-gap guard before traffic (section 3).
- Automatic deletion only after at least 30 days without a qualifying touch, and only when no retained descendant or in-flight operation still needs the data. Every startup and clock uncertainty also establishes a no-delete barrier lasting a full trusted monotonic idle window (default 30 days). Replay continues during the barrier; frequent restarts deliberately overretain. No hard maximum age for active state. Markers (poison, ambiguity, nonreplayable) outlive payloads and are never dropped for budget reasons.
- Preserve original output blocks, not individual encrypted fragments.
- Match at complete Chat message boundaries, never inside a message.
- **Canonicalization is total** over any Chat-shaped `messages` array, so scope and prefix are semantically derivable and conflicts can be observed. **Eligibility** (may this request replay/admit?) is a separate allowlist predicate applied afterwards. Execution is bounded: a reserved preflight counts canonical lengths and structural limits before framing/emission, without allocating unbounded width, sorting, escaping or scope scratch.
- Exact supported history and conservative configuration scope; meaningful edits cause misses.
- Validate known hidden ancestry as metadata, without adding another lookup index. The newest verified record dictates the replay plan, so one transient bypass costs one turn, not the conversation.
- Fail closed on ambiguity, unsupported data, or incompatible ancestry **at the granularity of one prefix position** (prefix poisoning). Markers are keyed on `(scope, kind, digest)` with no generation, so a fence cannot re-open them. Scope-wide fencing is reserved for `input`-shaped bodies in an enabled scope, ledger-integrity faults, and recovery from an unobserved disabled-mode gap; matching resumes automatically in a new generation.
- Resource refusal that is a deterministic function of `(scope, canonical history)` skips replay/capture without invalidating anything. Only load-dependent refusal poisons a position; if bounded guard work cannot be performed, do not forward an unobserved cache-affecting request.
- No automatic billable retries and no claim of lower cost, higher quality, or perfect session attribution.

## 2. Evidence

Repository inspection on 2026-09-05 (`src/`) and structural measurement of the relay's own recorded traffic (2,327 requests / 2,324 streams; roles, field names, sizes, digests and item-type sequences only — no prompt content):

- `chatToResponses.ts` translates messages but does not restore reasoning or explicitly disable response storage. `handledKeys` silently absorbs `n` and `stream_options`; `include` is not handled, so the relay has never sent it.
- `chatMessages.ts` drops tool-message `name` and `tool_calls[].index`, and flattens assistant `content` arrays to a string.
- `convertStream.ts` ignores reasoning items and **silently discards function calls whose `item.id` is absent**; `convertResponse.ts` ignores refusal parts. Both converters flatten multiple original text messages into one content string.
- `relayResponse.ts` sees both original events and emitted client frames; `res.write()` is not awaited. On client abort the `for await` throws out of `streamConverted`, so post-loop code is unreachable — cleanup must live in a `finally` registered before the first write.
- `http.ts` aborts the upstream fetch when the client socket closes before `writableFinished` — this is what Cursor's Stop button does. Several such aborts were recorded in one day of use. `upstream.ts`'s `fetch` has no timeout.
- **Every** recorded Cursor request is Chat-shaped (`messages`), `stream: true`, with `user` and **`stream_options` (2,327 of 2,327)**. Zero `input`-shaped bodies.
- In Cursor-resubmitted history: assistant `content` is **always an array** — `[]` for tool-only turns, `[{type:"text",…}]` for text; tool messages carry `name` (≈99% of requests, 20,669 messages sampled); `tool_calls[]` carry `index`, echoed back identically (280/280).
- Across 280 continuation pairs, assistant text and tool-call IDs matched what Cursor resubmitted **280/280**. Exact-byte envelope prediction matched 252/280; after parse-and-reserialize of tool-argument strings, **280/280**. Cursor strips insignificant whitespace inside argument JSON.
- Tool-call IDs are per-generation nonces (447/447 distinct). Same-prefix ambiguity is practically confined to **text-only** assistant envelopes.
- Of 18,529 sampled assistant messages, **1,301 (7%) omit the `tool_calls` key entirely; `tool_calls: []` occurs 0 times.** The SSE accumulator emits `tool_calls: []` for text-only turns, the JSON path omits the key. The 280/280 pinning normalized both sides to always carry an array and therefore did not cover this shape.
- Canonical byte length is ≈ 0.95 × raw; the largest canonical history is ≈ 5.2 MiB. Max canonical nodes per request: 16,183 in `messages`, 16,702 whole body (2,406 requests). Max assistant envelopes per request: 591.
- System prompt and tool array are byte-stable within a conversation; two distinct system prompts and two distinct tool arrays across 300 sampled requests.
- Request bodies: mean 0.8 MiB, **max 5.5 MiB**. **Max 1,546 messages** per request, **max 11 parallel tool calls**, max JSON depth 14 (tool schemas 13, messages 7). All grow or stay flat within a conversation.
- `response.incomplete` occurred once in 2,324 streams; ~40–60% of completed responses contain **no reasoning item**. Sampled Astra responses contain non-empty `encrypted_content` under the current `store: true`, `include` absent configuration, with effective `reasoning.context: "all_turns"`.
- Sampled headers contain no conversation identifier.

OpenAI documents stateless replay of complete output items including encrypted reasoning; `response.output_item.added` reasoning content may be incomplete — use completed items. Stateless output includes encrypted reasoning by default; explicit `include: ["reasoning.encrypted_content"]` remains accepted.

The relay cannot decrypt, interpret, summarize, merge, or repair encrypted reasoning. Model support determines whether reasoning from earlier user turns is used. These are inherited observations, not revision-10 measurements; the new preparation-memory and timer/retention contracts still require validation.

## 3. Feature boundary

Version one covers converted Chat Completions requests whose `messages` history passes the eligibility allowlist (section 5) with supported stateless upstream configuration.

Behavior by request class:

- **Feature disabled, no existing store and never enabled:** existing relay behavior, no cache, no new replay controls, and no creation of a database, secret, WAL/SHM files or cache directory. Checking whether the configured store exists must not open SQLite in a mode that creates it.
- **Feature disabled, existing store:** preserve existing request translation and upstream controls; do not replay, capture, load payloads or canonicalize requests for the cache. Before admitting traffic, acquire exclusive ownership and commit the metadata-only disabled-gap guard described below. This safety write is the explicit exception to “disabled means no cache activity.”
- **Enabled, eligible, hit or miss:** ordinary visible translation with verified replacements where possible; explicitly use `store: false` and merge `reasoning.encrypted_content` into supported include values.
- **Enabled, Chat-shaped but ineligible** (a refusal part, a remote `image_url`, an unknown message-level field, an unclassified behavior-affecting top-level field or header): no replay, no admission. Because canonicalization is total, scope and prefix are still derivable, so the **observation contract applies**: the completed visible identity is observed at its prefix and can mark an older identity ambiguous. This never fences.
- **Enabled, prefix not derivable** (`input`-shaped bodies, bodies with both `input` and `messages`, explicit `previous_response_id`/`conversation`): outside the cache. Cursor sends `input`-shaped bodies for **registry** model names and `messages`-shaped bodies for **alias** names (README, “How it works”), so co-occurrence is a user-behavior question, not a Cursor invariant: 0 of 2,327 observed (test 3 re-checks). If one is observed while the feature is enabled, fence **all scope-generation rows sharing (credential fingerprint, resolved model, caller)**, where caller is derived from `safety_identifier` or `user`; if neither is present, fence on (credential, model). Users who alternate registry and alias names fence once per switch — a hit-rate cost, not a safety issue. The fence protects **existing** records only; a later new-generation record at the unobserved position can still be matched by the `input`-shaped conversation's branch — the accepted unobserved-generation limitation (section 16).
- **Enabled, deterministic resource refusal** (canonical ceilings and counts, section 12): no replay/capture, no intent, no invalidation.
- **Enabled, load-dependent resource refusal** (lease exhaustion, wall-clock budget): no replay/capture; poison the prefix position using the reserved bounded guard path (section 7). Fence only if the ledger itself cannot be written. If neither the guard nor a durable safety transition can complete, do not dispatch upstream; load pressure is not an intent-less deterministic skip.

### Disabled-mode gap and re-enable contract

Disabled traffic is unobserved and could produce the same visible identity with different hidden output. Therefore disabling cannot simply leave old records eligible for a later re-enable.

1. On disabled startup with an existing store, open only the existing store, acquire the normal exclusive-owner write lock, and validate the metadata needed for safe recovery without fetching replay payloads. **Before any traffic**, durably set a store-wide `disabled_gap_pending` marker. Keeping the owner guard for the disabled lifetime prevents an enabled second owner. A crash after this write must leave the gap visible. If ownership, validation or the guard commit fails, fail startup/traffic rather than silently forwarding against an unguarded old store; never silently replace a missing/corrupt secret over an existing store.
2. Disabled mode performs no per-request replay bookkeeping or new replay controls. The guard is conservative even if that disabled run happens to receive no traffic. It is store-wide because disabled requests do not derive cache scopes; it must cover every stored scope, not just the current key/model/caller configuration.
3. Before re-enabled traffic, transactionally quarantine **all pre-gap payload generations**, advance their scope generations, poison and resolve any unresolved pre-gap intent positions, and consume `disabled_gap_pending` only in the same successful recovery transaction. Preserve generation-less poison, ambiguity and nonreplayable markers, observation fingerprints, payloads, touches and dependency data; quarantine is not deletion and does not override retention. Publication and hot-cache validation must reject pre-gap generation/epoch values. A crash before or during recovery leaves either a pending gap or the fully committed quarantine; it cannot reopen old payloads.
4. Enabled-to-disabled transitions, if supported without a restart, first stop new cache dispatch/publication, drain or poison outstanding work, and persist the gap before allowing unobserved traffic. Re-enable uses exactly the same recovery boundary. A normal continuously enabled restart, with no gap or restore, does **not** rotate generations.
5. On a genuinely never-enabled installation with no store, disabled startup and traffic create no cache artifacts. First enable may create a fresh store. An existing store must never be treated as “never enabled” merely because its metadata or secret cannot be read.

An upstream rejection is surfaced normally. Do not automatically change storage semantics again or retry without replay. `store: false` disables Responses application-state storage; it is not a blanket zero-retention guarantee. The gate verifies `store: false` and the `include` value independently against the current working baseline before both are switched on for every eligible request (test 13).

## 4. Invariants

1. Cursor's visible history remains authoritative. Restore no visible output absent from it.
2. Replace exactly one verified complete assistant envelope with its original output block; no duplicate answers or calls.
3. All matching hashes use visible history only, never reinserted encrypted items.
4. Every field that is **preserved into the dispatched upstream request** is either hashed or makes the request ineligible. Fields that translation drops before dispatch may be hashed freely (extra hashed content can only cause misses, never false matches).
5. Canonicalization is total over Chat-shaped bodies; eligibility is decided afterwards by an executable allowlist. Actual counting/emission is allocation-bounded before feature-owned scratch is created.
6. A unique visible match alone is insufficient: the selected replay plan must equal the record's recorded prior plan, and every replayed block — ancestor or dictating — passes the same verification predicate.
7. Publish only complete, immutable, independently replayable output blocks with a nonempty visible projection, fingerprinted from the **frames actually written to the client**.
8. Observe conflicts whenever scope and prefix are derivable, independently of eligibility and of whether the payload fits, subject only to the same-scope deterministic-refusal proof in section 12. Unobserved disabled traffic requires a durable pre-traffic gap guard and pre-gap quarantine on re-enable.
9. Re-check eligibility at dispatch, including unresolved same-prefix intents; fence late publications across generation changes and poisoned positions. Expiry must re-check the current phase and progress revision, not act on a stale scheduled deadline.
10. Automatic reclamation never deletes recently touched or dependency-protected data merely to meet a size limit. Markers are never dropped for budget reasons. Every restart/clock uncertainty renews the trusted-monotonic no-delete barrier without disabling replay.
11. Bound preparation, hot-cache data, capture, database operations and active replay allocations before allocating feature-owned data, including scope construction, object width/sort workspace and escaped-string chunks. A refusal that is a deterministic function of `(scope, canonical history)` never invalidates cached state.
12. Default operational logs contain no payloads, credentials, or raw history digests.

## 5. Canonical visible-message envelopes and eligibility

### Total canonicalization

For any Chat-shaped body, each message is canonicalized as **sorted-key `JSON.stringify` output of the raw message object**, with the following normalizations applied first (each pinned by a fixture):

- `tool_calls[].index`: if present, validated as `0..n-1` in array order and removed; if absent, valid; present-and-inconsistent → ineligible (but still canonicalized, with the raw value kept).
- Assistant `tool_calls`: `[]` ≡ absent (no calls). Safe under invariant 4: `chatMessages.ts` maps both to zero `function_call` items. Cursor always omits the key on text-only turns; the SSE accumulator emits `[]`, the JSON path omits it.
- Assistant `content`: `"x"` ≡ `[{type:"text",text:"x"}]`; `[]` ≡ `null` ≡ absent ≡ `""` ≡ `[{type:"text",text:""}]` (no visible content). The emitted-envelope fingerprint (below) is computed after the **same** normalization; the SSE path emits `content: ""`, the JSON path `null`, Cursor resubmits `[]`.
- These equivalences apply to **assistant** messages only. For `user` and `tool` messages, string-vs-parts survives into the dispatched request (`toInputContent` maps a string to a string and an array to `input_*` parts), so collapsing them would violate invariant 4.
- Everything else, including unknown fields, is included as opaque content. Unknown fields make the request ineligible but never underivable.

Canonical JSON is value-exact after decoding; byte-level variations that decode identically are equal. Because ES2019 `JSON.stringify` is well-formed (unpaired surrogates are escaped as `\uD8xx`), UTF-8 framing of the canonical output is injective; no separate well-formedness rule is needed. No free-form numeric fields are in the eligibility allowlist, so numeric serialization ambiguity cannot reach a hit.

**One serializer, two bounded modes.** A single serializer implementation serves incoming history, the emitted-envelope fingerprint and the scope seed. Its **count mode** computes the exact canonical UTF-8 length and structural/scratch requirements; its **emission mode** produces the same canonical bytes in bounded chunks. Both share normalization, scalar encoding and traversal semantics; output **must byte-equal sorted-key `JSON.stringify`** — including handling of control characters, `\u2028`/`\u2029`, lone surrogates (escaped) and non-BMP characters (emitted raw). The injectivity argument above depends on this. Each framed value's count must be known **before** its length is written into the hash. No “measure while emitting a length-prefixed frame” shortcut, full canonical-string copy, or separate capture/scope serializer is permitted. Count/emission consistency and memory reservations are specified in section 7. Test 4 is a differential fixture over the whole recorded corpus plus adversarial strings; a serializer divergence between the incoming and capture paths would make every record unreachable while single-path tests pass, which is the failure mode that consumed rounds 6 and 7.

Incoming tool-argument strings are hashed **exactly as received**. Do not normalize whitespace, strip timestamps from prompts, replace paths, or rewrite call IDs. Preserve message-envelope boundaries; never merge or split adjacent messages.

### Eligibility allowlist (version one, derived from recorded traffic)

| Role | Allowed fields |
| --- | --- |
| `system` / `developer` | `role`, `content` (string or text parts) |
| `user` | `role`, `content` (string, text parts, inline `image_url` data URLs); remote image/file URLs → ineligible |
| `assistant` | `role`, `content` (any normalized shape above), `tool_calls[]` with `id`, `type`, `function.name`, `function.arguments`, optional `index` |
| `tool` | `role`, `tool_call_id`, `content` (string or text parts), `name` |

Anything else at any level — unknown fields, unsupported roles/parts, refusal shapes (Cursor-side stored form unknown) — makes the request ineligible for replay/admission. A field that translation drops before dispatch (`name`, `index`, `n`, `stream_options`) is **not** a reason for ineligibility; the hazard invariant 4 guards is a field preserved into dispatch but absent from the hash.

### Captured output

Fingerprint the **actual complete Chat assistant message emitted to the client**: the accumulator is fed exclusively from the frames handed to `res.write` (or the JSON object handed to `sendJson`). The projection derived from `response.output` is a cross-check only; divergence (a function call the stream converter dropped for a missing `item.id`, a refusal part the JSON converter ignored) fails admission. **Observation always uses the client-frame identity** — what Cursor saw — never the `response.output` projection.

Prediction of what Cursor will resubmit applies **one pinned normalization** on the capture side only: each tool-call `arguments` string is parsed and re-serialized (`JSON.stringify(JSON.parse(args))`). Invalid JSON → prediction undefined → not admitted. Pinned against 280/280 recorded pairs; if Cursor's serializer differs on edge cases the corpus lacks (`1.0`, exponents, > 2^53, `-0`, duplicate keys, non-ASCII escapes), the result is a miss, never a false match, because the incoming side hashes as received (test 2 asserts this explicitly). Reserve capture/observation capacity before argument parsing, prediction or canonicalization; a capture-side resource failure is observed/nonreplayable or position-poisoned under section 10, never an incoming-history deterministic skip.

Original `message("Checking. ") -> call A -> message("Done.")` projects to one Chat envelope with `content: "Checking. Done."` and `tool_calls: [A]`; the cache keys this envelope while retaining original item ordering and `phase` for restoration. A text-only envelope cannot match the text prefix of a text-plus-tool envelope; one call cannot match a prefix of a two-call envelope.

## 6. Scope and effective configuration

Seed history hashing with a versioned canonical pre-request scope, computed from **classified scope-forming fields only** — an unclassified field affects eligibility, never scope identity, otherwise an observe-only request would land in an orphan scope that no eligible request reads and its observation would protect nothing (safe because the translator drops every unknown top-level key, invariant 4):

- Canonicalization/projection/cache version **and the deterministic ceiling and count vector** (section 12), including scope/width ceilings, so refused-under-old-limits and admitted-under-new-limits never share a namespace. Operational consequence: tuning any ceiling makes the existing cache unreachable (not deleted; it idles out). Intended, but surprising for a knob labelled “subject to measurement”.
- Normalized upstream origin and endpoint.
- HMAC fingerprints of configured OpenAI credentials and relay authorization scope, using a cryptographically random persistent cache-local secret created atomically and retained across restarts. Store no raw API keys. Missing/corrupt secrets must not be silently regenerated over an existing store.
- Caller (`user`/effective safety identifier) when present; absent is a distinct value.
- Effective outbound resolved model name, not the Cursor alias.
- Supported semantic upstream headers, including the exact effective `openai-beta` value.
- Effective model-affecting body configuration outside history: instructions, tools/tool choice, reasoning configuration, sampling/output limits, output formats, and other supported upstream settings.

**Classification registry** (every forwarded field/header has exactly one class; test 3 asserts the recorded corpus is fully classified):

- *Scope-forming:* the list above.
- *Transport-only, excluded:* HTTP accept/content-type mechanics, compression, tracing, `stream`, **`stream_options`**.
- *Dropped before dispatch, harmless:* `n`, message-level `name`/`index` (hashed as content).
- *Feature-owned, fixed for eligible requests:* `store`, `include` — represented by the cache format version.
- *Unclassified behavior-affecting:* → semantically ineligible (observed, not fenced) until classified.

Capture and lookup use **the same outbound pre-request values**. Scope is a bounded traversal/view of classified values, not an eagerly cloned or stringified tools/configuration object. Scope bytes, keys, sorting, escaping, nodes and depth pass the same reserved count/emission discipline as history **before** any scope frame or digest is emitted; large tools/instructions cannot bypass the preparation bound.

**Model-snapshot skip.** Each scope keeps a durable row of response-model snapshots observed in the last 24 hours **plus the last observed snapshot of any age** (updated transactionally with observations; nothing observed yet → no skipping). At lookup, a record whose recorded snapshot is in neither is skipped (not sent). This is a **fail-open heuristic that reduces** user-visible upstream 400s after OpenAI rotates the snapshot behind an alias, not a guarantee: during a gradual rollout the set holds two snapshots and a record may still be served by the other one and rejected, after which attributable invalidation and a clean retry apply. The check applies to the **dictating record only**, and checking ancestors individually would be wrong: an ancestor's own recorded snapshot is necessarily older, but its ciphertext was re-accepted at every later generation in the chain, most recently under the dictating record's snapshot. Snapshot status governs upstream acceptance of ciphertext, never branch identity — it has no safety dimension.

Configuration changes cause misses. Because scope is in the seed, a generation under σ1 is never observed in σ2's ledger, and **poison markers are likewise scope-local**: a Stop under σ1 gives no protection if the same conversation is resumed under σ2 (e.g. Stop, then change effort). Stated limitation (section 16).

One shared credential without authenticated caller separation is one trust boundary. The client-supplied `user` field partitions cache data but is not authentication.

## 7. Unified incremental hashing

Use one SHA-256 state seeded with a domain tag and length-delimited canonical scope. Append each **complete canonical Chat envelope** as a framed value. The serializer counts canonical bytes **before** emitting the frame length, then streams canonical bytes directly into the hash; no complete canonical copy is materialized.

### Allocation-bounded preflight and emission

1. Before constructing scope scratch, normalization views, key lists or digest arrays, reserve a bounded preflight workspace under an aggregate lease. It accounts for traversal frames, enumeration state, object-key references, width/sort workspace (including the sort implementation's temporary storage), scalar/UTF-8 escape chunks, scope assembly and per-message length metadata. The pre-existing parsed request is not copied. Normalization uses bounded views, not full normalized-message clones.
2. Count canonical scope and history through the same serializer's count mode. Incrementally enumerate/count keys and array elements and check node/depth/width ceilings **before** retaining additional references or allocating a sort buffer. In particular, `Object.keys(hugeObject).sort()` followed by a width check is forbidden. Strings and keys are scanned for their exact encoded length without making a whole escaped string or UTF-8 buffer. Count mode need not sort keys to determine JSON byte length; it must use the identical property selection and normalized scalar encoding as emission.
3. Stop as soon as a deterministic ceiling is exceeded, release reservations, and take the intent-less deterministic skip. For admitted inputs, retain only bounded length/shape metadata; reserve any required emission workspace before allocating it. Scope and all message lengths are now known. All keys retained across active nested traversal frames and all live sort/escape buffers must fit the reservation, not merely the largest individual object.
4. Emit the scope frame and message frames with the pre-counted lengths. Key ordering is deterministic and matches the specified sorted-key JSON output. Scalars/keys are escaped into fixed bounded chunks. Count and emission operate on the same unmodified input view; verify emitted byte counts against the preflight counts. A mismatch is an integrity failure, not a successful hash or a deterministic resource refusal; do not dispatch an unobserved cache-affecting request on that path.
5. Only complete envelope boundaries produce prefix digests. A separate aggregate cap bounds retained digest lists. If that cap is unavailable, use an already reserved bounded guard walk that retains only the final digest, then poison that position before ordinary dispatch; never allocate a digest list speculatively. Preflight/guard capacity itself is also aggregate-bounded. If it cannot be obtained, reject before upstream dispatch rather than silently forwarding without an intent or marker. Cache/plan state and lease availability cannot become deterministic ceilings.

```text
reserve bounded preflight/guard workspace, including scope and serializer scratch
counts = canonical.count(scope_view, normalized_message_views, deterministic_limits)
if a deterministic ceiling is exceeded:
    release workspace; skip replay/capture without intent or invalidation
reserve bounded emission workspace and optional digest-list slot
state = SHA256(domain_tag)
state.update(frame_length(counts.scope_bytes))
canonical.emit(scope_view, state)                  # exact pre-counted bytes
prefix[0] = digest(copy(state))                    # only when a list slot is held
for message, byte_length in counts.message_boundaries:
    state.update(frame_length(byte_length))       # length BEFORE payload bytes
    canonical.emit(message, state)               # bounded sorted/escaped chunks
    prefix[next_boundary] = digest(copy(state))   # or retain final digest only
```

`frame_length` encodes the UTF-8 byte length unambiguously. SHA-256 collision resistance is an engineering assumption.

Memory is **not just O(depth)**: it includes bounded key-reference/sort/escape/scope scratch and count metadata, plus 32 bytes per retained boundary (≈ 205 KB at the 6,400-envelope ceiling). All are covered by explicit per-request and aggregate reservations before allocation. The deterministic ceilings bound the count/emission work; the count pass aborts as soon as a ceiling is crossed. An aggregate cap on concurrently retained digest lists (initially 64 requests) bounds the N-concurrent-large-requests case; exceeding it is a load-dependent refusal. For any Chat-shaped body **within the deterministic ceilings**, the reserved guard path can compute the final visible prefix without retaining a digest list, which lets prefix poisoning replace scope fencing on the load-dependent path.

`endDigest` for a captured record is `digest(extend(copy(state_at_startDigest), frame_length(count(predicted_envelope)), emit(predicted_envelope)))`, using the same serializer and capture/observation reservations. The live hash state at the final boundary is retained across dispatch and capture and charged to the capture lease. A capture failure follows section 10, not the deterministic incoming-request skip path.

## 8. Output-block records and known provenance

A record contains:

- `startDigest` (pre-output) and `endDigest` (post-output).
- The emitted-envelope fingerprint (canonical normalized form).
- Complete original ordered `response.output`, including encrypted reasoning, original messages/phase, and function calls.
- Fingerprint of that exact replay payload.
- Immutable ordered **prior replay-plan descriptors actually dispatched**: each earlier replacement's start/end digest and payload fingerprint (96 bytes each; 175 turns ≈ 17 KB on the last record, ≈ 1.5 MB cumulative; admission stops at 10,000 descriptors).
- The **producing intent id** as a nullable non-FK column (intents are tombstoned/removed on resolution).
- Recorded response-model snapshot, scope/generation ID, `created_at`/`last_touched_at` UTC, row version, accounted size.
- Durable dependency edges to the exact earlier blocks in its dispatched provenance.

Lookup is only by visible `endDigest` within scope/generation. Indexes on `startDigest`, age and dependency columns serve invalidation, retention and integrity — not matching.

### Plan selection: newest verified record dictates the plan

Walk the visible history and collect verified candidates. Let the **newest** verified record dictate the plan: plan = that record's recorded prior plan + itself, provided **every referenced ancestor passes the same verification predicate as the dictating record** — present with the same payload fingerprint, same generation, current row version, not poisoned, not ambiguous, no unresolved same-scope intent at its `startDigest` other than its own producing intent (snapshot excepted, see section 6) — and each descriptor's `endDigest` appears in the current prefix list (cheap assertion; guaranteed by hash chaining). If not, fall back to the next-older verified record's plan; if none qualifies, dispatch without replay.

Safety by induction: a recorded plan was built by this algorithm, so each element's own prior plan is exactly the plan prefix preceding it. Replaying a strict prefix of a chain replays nothing hidden after its last element. This preserves the ancestry rule — never insert an ancestor a descendant was generated without, never omit one it was generated with.

Recovery after poisoning: no plan that includes the poisoned position qualifies, so the walk falls back to the newest record **before** it; the next dispatched generation records that chain (empty only if the poisoned position was the first replayed one) and replay rebuilds from there. A transient bypass costs one turn's hits. A position that was not admitted (no reasoning, unsupported output, ineligible) contributes nothing to later plans. Hit rate is bounded by the fraction of responses carrying reasoning.

Applying the in-flight-competitor check to ancestors is conservative: messages after an ancestor already prove the history descended from a completed generation there. It may be relaxed later with that argument; version one keeps the uniform predicate.

## 9. Replay planning and dispatch

```text
before traffic: complete owner/recovery checks and disabled-gap guard or re-enable quarantine
if disabled: preserve ordinary relay behavior; do no per-request cache work
reserve bounded preflight/guard workspace before any scope or serializer scratch allocation
count canonical scope/history lengths, nodes, depth, width and deterministic counts
    if a deterministic ceiling/count is exceeded -> skip replay+capture, no intent, no invalidation
reserve emission workspace; attempt aggregate digest-list slot
emit pre-length-framed scope/messages using the same serializer
    if digest-list slot refused -> final-prefix-only guard walk, poison before ordinary dispatch
    if guard work cannot be reserved -> reject before upstream dispatch, not an unobserved bypass
reserve preparation lease for post-walk work (candidate rows, plan); on refusal -> poison final prefix
apply eligibility allowlist -> eligible or observe-only
collect candidates by end digest (batched IN lookups within the per-request DB budget;
    plan size pre-checked against the critical-section bound before the transaction)
verify each candidate; select plan from the newest record whose whole plan verifies
validate replacement intervals and supported call/result sequence
reserve aggregate in-flight replay memory before materializing output
prepare reconstructed input from visible spans/original blocks
at the dispatch boundary, in one synchronous critical section:
    revalidate every replayed record (dictating and ancestors): versions, generation/epoch,
        ambiguity, poison, snapshot (dictating), and for ALL unresolved same-scope intents
        at the record's startDigest: refuse unless every such intent is the record's own producing intent
    commit touches, dependency protection and the durable in-flight intent
        (scope, generation, startDigest, generating phase, progress revision, inactivity deadline)
    hand off to transport; arm generation inactivity tracking before waiting for response headers
if any replay check fails -> dispatch ordinary translated input (intent still written)
if the intent commit fails -> poison the position; if that fails -> fence; if that fails -> stop
```

Replace a verified assistant envelope with its complete original block exactly once. Keep user messages and tool results from the current request. Validate no orphan/duplicate calls/results; do not fabricate missing items.

```text
Cursor: user -> assistant envelope(call A) -> tool result A
Cache:  original [reasoning R, call A], tied to that envelope/prefix
Relay:  user -> reasoning R -> original call A -> tool result A
```

### Dispatch is the linearization point

Exactly one relay process owns the store: one persistent `node:sqlite` connection with `PRAGMA locking_mode=EXCLUSIVE`. The exclusive lock is acquired on first access, not on `open`, so startup performs a write inside the ownership check and treats `SQLITE_BUSY` as “second owner” (test 20). All DB mutations, cleanup, dispatch validation and publication are serialized by that owner. Disabled startup with an existing store uses the same ownership discipline for its metadata-only guard before traffic; it is not an unguarded second owner.

The **same-prefix in-flight competitor** check: if request B is regenerating from prefix P while request C wants to replay a record at `startDigest = P`, C must not replay — the relay knows B is in flight. The exemption for the record's own producing intent is sound because a verified full-envelope match in C's history is itself proof that the producing generation's output reached Cursor: the current request's history is the delivery receipt. The condition is universally quantified — with two unresolved intents at P, one of them the producing intent, it still refuses. Tool-call-ID nonces confine the cost to text-only envelopes.

### Progress-renewed generation and separate delivery timers

**Intent lifecycle is bounded by inactivity, not by total generation age.** The initial inactivity default is **15 minutes**, independently configurable for upstream generation and local delivery. These are initial policy defaults, not measured optimal values. A ten-minute silent high-effort generation must survive the default; silence beyond the applicable inactivity deadline is still a stall.

- **Generating phase:** arm the upstream inactivity timer at dispatch, including the wait for initial response headers. Receipt of headers or additional upstream body bytes is progress (SSE bytes on the streaming path, headers/body bytes on JSON). Renew the live monotonic deadline and the intent's progress revision on real progress, including bytes that have not yet yielded visible output. There is **no fixed `dispatch + upstream timeout + delivery timeout` intent expiry**. A response making progress can run longer than 15 minutes or longer than the initial deadline without poisoning.
- **Durable renewals:** intents record phase, progress revision and the corresponding deadline metadata. Persist progress renewals at a bounded cadence and at phase changes, avoiding a DB write for every byte. The running owner tracks latest monotonic progress; cleanup/expiry must consult that live state and reconcile any coalesced renewal before treating a stored deadline as expired. A stale persisted deadline is never sufficient to expire an actively progressing intent. Startup does not try to resume a lease from wall-clock metadata: it poisons and resolves every unresolved intent as before.
- **Delivery phase:** completing upstream generation cancels its timer. In the output/observation transaction, transition to `delivery_pending`, change the phase/progress revision, and start a **fresh**, separate delivery deadline before terminal writes/JSON delivery. Do not borrow a deadline measured from dispatch. Actual local write/drain progress renews the delivery inactivity timer; repeated attempted writes, timer ticks or continued upstream activity alone do not. Resolve only on the required successful `finish` condition. While generation is still active, pending client backpressure also has its own delivery-stall timer, so continuing upstream bytes cannot keep a blocked client alive forever. Do not arm a delivery-stall timer merely because a high-effort upstream has emitted no client data yet.
- **Expiry race check:** timer callbacks and bounded expiry sweeps re-enter the serialized owner boundary and re-read intent existence, generation/epoch, current phase, progress revision and the current monotonic deadline. A callback scheduled before a renewal or phase transition is stale and does nothing (or reschedules against the current deadline). If still expired, atomically claim expiry, poison its position and resolve it; abort/cleanup releases its reservations. Completion, delivery, abort and expiry race through the same transition rules, so none can publish after an expiry claim or resurrect a resolved intent. Fence and disabled-gap recovery similarly reject late renewals/publications.
- **Bound stalled work, not all work:** expiry processes bounded batches and targets only intents that are still inactive in their current phase after revalidation. No maximum-total-age sweep, fixed birth-time TTL, “expire every unresolved intent” maintenance shortcut, or another request's progress/timeout may kill a healthy live generation. Startup recovery is the explicit exception: there is no surviving live owner then. A genuinely stalled generation or delivery is eventually poisoned/resolved and cannot pin plans, competitors or storage forever.

The durable intent is required even on a miss and for observe-only requests: the generation could finish with output colliding with an existing identity. Deterministically refused requests write no intent and are invisible to the competitor check; this is consistent because such a request can never produce an identity at a position where an eligible identity exists (section 12).

Rows older than 30 days but not yet reclaimed are still reusable; 30 days makes them potentially eligible for deletion after all other guards, not invalid. Create the final serialized payload once; request logs describe the **actually dispatched** payload. After dispatch, a later conflict cannot recall upstream work.

## 10. Completion capture, conflict observation, and publication

1. Record the durable intent and exact dispatched replay-plan provenance when the request is sent. Register `finally`/lifecycle handlers before the first client write.
2. Collect finalized items from `response.output_item.done`, ordered by `output_index`, renewing generation progress from real upstream activity independently of item completion or visible output.
3. At successful `response.completed`, reconcile `response.output` with the client-frame accumulator and finalized items. Completed reasoning ciphertext is authoritative: a ciphertext-only difference from the same-ID `output_item.done` is permitted when both ciphertexts are nonempty and every other item field matches. Other divergence → not admitted, still observed (client-frame identity). Never splice ciphertext from different generations or accept visible text/tool-argument changes.
4. Observe the completed visible identity and its payload/provenance fingerprint before deciding whether to retain the payload.
5. Same identity + same payload/provenance is idempotent. Different payload/provenance marks the identity ambiguous.
6. If a completed response cannot be safely retained/compared (oversize, unsupported original output, capture failure), mark its identity nonreplayable. If the identity cannot be computed (unknown Cursor-side form), poison the position.
7. Re-check that the intent is live and has not lost an expiry/fence/disabled-gap race. Commit output, observation/ambiguity state, dependency edges, touches, and the intent transition to **delivery pending** with its fresh delivery deadline/progress revision in one transaction **before** emitting finish/`[DONE]` (or the JSON). Stop the generation timer at this phase transition. Publish to the hot cache only after commit.
8. Resolve the delivery-pending intent only after successful local terminal delivery (`finish` with all terminal data submitted and no earlier delivery error), using the same serialized phase/expiry checks and cancelling remaining timers. A normal `close` after `finish` is not a failure.

### Interrupted, failed and truncated generations — one rule

For Stop/abort, premature `close`, delivery error or timeout, `response.failed`, `error`, `response.incomplete`, upstream error after partial text, **a revalidated current-phase inactivity expiry**, or a crash before intent resolution (an unresolved intent at startup):

- **Poison the position:** durably mark `(scope, poison, startDigest)`. All records with that `startDigest` become nonreplayable in every generation; future admissions there are observation-only. Whatever partial envelope Cursor retained is appended at that prefix, so poisoning covers every candidate identity the relay cannot distinguish — a superset, within the scope. The relay knowing what it *wrote* is not the same as knowing what Cursor *stored*: for error- or length-terminated streams Cursor's stored form is unpinned (it may keep the text and drop a partial call, keep nothing, or keep everything), which is the same argument that rejects an identity-only rule for aborts. Cost: one position per rare event (1 `response.incomplete` in 2,324 streams).
- **Additionally**, if `finish` completed with no earlier delivery error, mark the accumulated identity nonreplayable as well — an addition, never the sole action. The only precision exception permitted: `response.incomplete` with a **text-only** accumulated envelope delivered with a normal `[DONE]` is indistinguishable from a normal completion from Cursor's side; once a fixture pins Cursor's stored form for `finish_reason: length`, that case may mark the identity only.
- **Upstream error before any output** (e.g. a 400 on a replay request; `relayUpstreamError` delivers the error body): no envelope was written, so there is no identity to mark. Version one poisons the position anyway (always safe). Optional later relaxation: with zero frames written, any assistant message Cursor could synthesize is either empty (never admitted) or not model output, so “zero frames written → no marker” is justifiable and would recover the turn's caching after transient 429/5xx errors. “Attributable payloads” to invalidate (section 13) are exactly the blocks replayed in that request.
- Do **not** fence the scope for an individual interruption. Scope fencing is reserved for: an `input`-shaped body in an enabled scope, the ledger being untrustworthy, an intent without a position (ledger-integrity fault), or re-enable after an unobserved disabled-mode gap. A fence increments the durable generation, **poisons the `startDigest` of every unresolved intent in that scope** (so an old-generation generation completing after the fence cannot leave a new-generation identity falsely unique), quarantines old payloads, and resumes matching automatically in the new generation. Disabled-gap recovery covers all pre-gap scopes as specified in section 3. Manual action is required only for destructive reset.

A response must contain nonempty completed encrypted reasoning and a nonempty emitted visible envelope to be replay-admitted. A completed response lacking reasoning still invalidates a prior identity if its visible output collides.

Successful local delivery is not proof of Cursor receipt beyond the relay's socket; poisoning bounds the blast radius of undetected truncation to one position. A follow-up dispatched before the interruption becomes observable is nonretroactive.

## 11. Durable storage, 30-day idle retention, and recovery

### SQLite is authoritative

Payloads, identities, **markers keyed on `(scope, kind, digest)` with no generation**, dependency edges, scope-generation state (carrying credential fingerprint, resolved model and caller as columns for fence targeting), store-wide disabled-gap/recovery metadata, intents with phase/progress/deadline metadata and `last_touched_at` live in a local SQLite database. A prefix digest is simultaneously the `endDigest` of the record ending there and the `startDigest` of every record starting there, so the kinds must not be conflated: **poison** is read against `startDigest`; **ambiguity** and **nonreplayable** are read against `endDigest`. Generations scope only payload replayability; markers apply across generations. The RAM hot cache is disposable.

Atomic transactions, foreign-key enforcement, WAL, `synchronous=FULL` initially, bounded prepared queries. A supported backup includes the secret and a consistent snapshot. Clean continuously enabled restarts preserve everything; normal restart does not rotate a generation, but **always renews the retention no-delete barrier**. A pending disabled gap or explicit restore requires quarantine instead.

### Qualifying touch

Sliding inactivity window of **30 × 24 hours** (configured value validated as ≥ 30). `created_at` never changes; `last_touched_at` advances on committed events: admission or repeated observation of that identity (including conflicts); a verified full envelope match in a real request (even if ambiguous/poisoned/bypassed afterwards); dispatch selecting the block or publication of a descendant referencing it. Touch the identity, its payload, and its required ancestry together (plan descriptors enumerate them). Scans, hot-cache loading, diagnostics, backups and failed shape checks do not count.

Day 29 use keeps an entry until at least day 59. Repeated use keeps it indefinitely. The startup/uncertainty barrier can extend retention beyond those dates; it is not a fabricated qualifying touch and does not modify `created_at`.

### Dependency-aware reclamation

Hourly bounded batches, **only after the startup/clock/restore no-delete barrier has elapsed**. A payload row is reclaimable only when its identity group's last touch is older than the trusted cutoff, no retained descendant requires it, no pending plan/dispatched request/capture protects it or its ancestors, and no unresolved intent exists at its `startDigest`. Delete descendants before ancestors or a validated closed set atomically. Never cascade-delete recently used descendants. Revalidate the barrier/clock epoch at the deletion transaction boundary; a cleanup candidate selected before a restart or new uncertainty cannot authorize deletion afterwards.

**Markers outlive payloads and are never dropped for budget.** Observation fingerprints, ambiguity marks and poisoned positions (~64 bytes each — hundreds of megabytes per year of heavy use, so “indefinitely” is realistic) are retained indefinitely, bounded only by an explicit destructive reset. If the marker budget is ever reached, the relay **stops accepting cache-affecting requests** rather than dropping markers (fencing would free nothing, since markers are generation-free). This closes purge-then-regenerate resurrection: an identity ambiguous 31 days ago cannot become unique because its payloads were reclaimed.

### Crash recovery

On startup: acquire ownership (write inside the check), validate schema/secret/store, load generation and disabled-gap state, and establish a fresh conservative no-delete barrier **before enabling any cleanup or accepting cache-affecting traffic**. If enabled with a pending disabled gap, transactionally quarantine all pre-gap generations as in section 3. For every unresolved intent: poison its `(scope, startDigest)` and resolve the intent in the same transaction. No manual step; other eligible positions replay normally. An intent without a position is a ledger-integrity fault → fence its scope. Disabled startup with an existing store commits its metadata-only gap guard before ordinary traffic; never-enabled disabled startup creates no store.

Clean shutdown drains generation and local delivery, or poisons unresolved positions, before removing intents. A clean shutdown does not certify elapsed wall time across the next restart and therefore does not waive the next startup's retention barrier.

### Backup restore is not an ordinary restart

Restoration is supported only via an explicit offline procedure: fence all restored generations (new generation, automatic resume), quarantine old payloads, and persist restore-protection metadata. Nothing restored is purged until a full trusted monotonic idle window (at least 30 days) has elapsed under the startup/uncertainty rules below. The next startup renews this barrier; a persisted wall-clock restore timestamp alone cannot authorize deletion. External rollback bypassing the procedure is undetectable and unsupported.

### Retention clocks and disk limits

**Default startup policy: no automatic retention deletion for 30 trusted monotonic days after every process start.** If the configured idle window is longer than 30 days, use that full window for the barrier too. Persist UTC touch timestamps and protection/clock-uncertainty metadata, but never treat wall-clock time elapsed while the process was stopped as trusted evidence that the barrier has expired. Establish a process-local monotonic baseline on each startup; elapsed trust is not carried across restarts, including clean restarts.

While running, compare wall-clock movement with the trusted monotonic timeline. On clock jumps, monotonic discontinuities or any inability to establish clock trust, persist `clock_uncertain`, stop destructive cleanup, invalidate previously selected cleanup batches, and renew the barrier for a full trusted monotonic idle window once a trustworthy baseline is available. While uncertainty persists, no countdown authorizes deletion. A persisted UTC `purge_not_before` value is a conservative additional guard, **never a substitute for the live monotonic barrier**. Touches use `max(existing, trusted_now)` so timestamps never move backwards. Cleanup requires both an elapsed barrier and the ordinary trusted-age/dependency/intent predicates in the same current clock epoch.

This also covers a large wall-clock jump that happened while the relay was stopped and cannot be diagnosed from in-process clock deltas. **Replay, observations and safe admission continue during the barrier**; the barrier is about deletion, not replay validity or scope fencing. Frequent restarts or repeated clock uncertainty may prevent reclamation indefinitely and cause overretention/quota pressure. That is an explicit conservative trade-off, not a reason to shorten retention or silently trust UTC. Normal intent resolution and safety-marker writes continue; they are not retention reclamation.

When the disk quota cannot accommodate a payload, **stop payload admission; never delete active rows or bypass the no-delete barrier.** Hit rate degrades until idle cleanup catches up (section 16). Markers and intents continue under the reserve; if even those cannot commit, stop accepting cache-affecting requests.

Retention is a storage promise, not a guarantee that OpenAI will still accept a month-old ciphertext.

## 12. Resource bounds and sensitive-state handling

Defaults, subject to measurement and the acceptance gate:

- `REASONING_CACHE_ENABLED=0`; `REASONING_CACHE_DB_PATH=data/reasoning-cache.sqlite`; `REASONING_CACHE_IDLE_DAYS=30` (validated ≥ 30); `REASONING_CACHE_MEMORY_MAX_BYTES=134217728`; explicit disk quota and free-space reserve. With no existing store, disabled defaults create no cache artifacts; with an existing store, the metadata-only guard is mandatory.
- **Deterministic ceilings, defined on canonical quantities measured by bounded count preflight** (never on raw body bytes, which depend on Cursor's serializer): canonical history bytes 32 MiB (observed ≈ 5.2 MiB canonical, 6.2×), **message envelopes 6,400 (observed 1,546, 4.1×)**, nodes 2,000,000 (observed 16,702 whole body, ≈ 120× — deliberately generous), depth 64 (observed 14, 4.6×), **candidate lookups 4,000 (observed 591 assistant envelopes, 6.8×)**. The node/depth budgets include scope traversal and history together. **No hysteresis** — it would require conversation state the relay does not have, and oscillation costs at most a hit.
- **Scope and width are bounded too:** initially cap canonical scope bytes separately at 32 MiB; bound each object's canonical key count and each array's canonical element count by the same 2,000,000-node ceiling, with the aggregate node/depth limits still applying. These are implementation ceilings, **not newly measured scope/width maxima**. Include them in the versioned ceiling vector. Count/check width before allocating key lists; reserve all simultaneous key-reference, sorting, stack, escape, scope and length-metadata scratch before allocation. A finite node limit does not by itself prove an allocator obeys it. Per-request and aggregate preflight reservations are part of the memory budget, separate from post-walk candidate/plan reservations. Gate measurements must establish the actual scratch cost and corpus headroom; no new measured headroom is claimed here.
- **Deterministic means a pure function of `(scope, canonical history)` and nothing else.** Candidate lookups qualify (one per assistant envelope). **Plan-derived quantities do not**: plan size, revalidation count and critical-section cost depend on what is currently in the cache — after a poison the same history yields a shorter plan — so they must never reach the intent-less skip path. They are bounded by **shrinking the plan** (fall back to the next-older dictating record until the bound is met), never by refusing the request; the request still writes an intent and observes. Descriptors per record (10,000) is an **admission** limit: the response is observed and marked nonreplayable, not skipped.
- **Load-dependent** limits are those that depend on other traffic or time: preflight/emission/guard and other leases, the aggregate digest-list cap, and the wall-clock bound on the synchronous critical section, which is **pre-checked from plan size** before the transaction — never aborted mid-commit. A load refusal uses a reserved final-prefix guard to poison, or rejects before upstream dispatch if guarded work is unavailable; it never becomes an unobserved deterministic bypass.
- Per-request DB work uses batched `IN (…)` within SQLite's parameter bound. Progress-renewal writes and expiry scans are bounded/coalesced without allowing stored stale deadlines to expire live progressing work.
- Separate leases for preflight/emission/guard work, post-walk preparation (candidate rows, plan), capture (including retained hash state and prediction scratch), aggregate in-flight replay/serialization, and observation.
- Initial upstream-generation inactivity timeout **15 minutes**; separately armed/configurable local-delivery inactivity timeout initially **15 minutes**. Both use actual progress and phase-aware race checks. These policy defaults are not latency measurements, and neither creates a maximum total generation age.

### Why deterministic refusal is safe without invalidation

Within a fixed scope — which includes the ceiling and count vector — every deterministic ceiling and count is a pure function of `(scope, canonical history)`. A refusal at prefix P therefore implies every same-scope request at P was refused, so no eligible identity at P exists to be left falsely unique; the refused request's own output can only create an identity at P, never at a shorter prefix. A scope exceeding its own canonical ceiling is refused uniformly for all requests with that semantic scope, even if no scope digest is emitted. Test 14 asserts: byte-different-but-canonically-equal bodies get the same decision; ceiling changes yield disjoint scopes; corpus replay yields zero refusals with ≥ 4× headroom against the measured maximum. The additional scope/width maxima and actual count/emission allocation behavior must be measured in the gate; the historical history measurements do not establish those results.

### Retained payload, DB and active consumers

Account separately for ciphertext, visible output, ancestry metadata, observation records, indexes, markers, hot-cache copies, preflight length metadata, scope views, width/sort workspaces and escaping/encoding chunks. Bounded SQL batches; never load the whole DB. Charge fetched rows before retaining them; reserve in-flight replay memory before materializing output; evicted-but-pinned payloads stay charged until released. Release leases on every exit path, including count refusal, failed emission reservation, stale phase callbacks, abort, expiry and disabled-gap recovery.

The feature bounds its **additional** memory; pre-existing SSE/body buffering prevents a whole-process claim.

Encrypted reasoning is sensitive replayable state; assistant text and tool arguments are retained in plaintext on disk. Owner-only permissions, excluded from Git, local storage trust assumed; no application-level at-rest encryption in version one. No raw API keys stored. `LOG_BODIES=1` logs are separate and not governed by the 30-day policy.

## 13. Errors, context limits, and observability

Counters/reasons only: verified hits, disk/hot hits, misses by reason, poisoned positions, ambiguous identities, ineligible-by-rule counts, fences, refusals (deterministic vs load), revalidated inactivity expiries by phase, oldest idle age, protected/reclaimed rows, storage growth, transaction/lookup/preparation time, disabled-gap guard/quarantine outcomes and retention-barrier state. These are proposed observability fields, not reported measurements.

On upstream validation/decryption errors: preserve the error; no automatic billable retry; invalidate attributable payloads without erasing the ledger; explicit retry with caching disabled is the user's. Such disabled traffic must still obey the existing-store gap guard, and re-enable quarantines pre-gap generations. Never retry after any output was streamed. Do not truncate user history to make restored reasoning fit.

## 14. Implementation map

- Total canonical serializer with a bounded count pass before length framing and a bounded emission pass, shared by history, scope and capture; reserve width/sort/escape/scope scratch before allocation; separate eligibility allowlist adjacent to `chatMessages.ts`; capture-side prediction normalizer pinned by fixtures.
- Classification registry (with `stream_options`, `n`) and versioned scope including the full ceiling vector; incremental hash helper with retained final state and bounded final-prefix guard fallback.
- SQLite store: payloads, identities, generation-less markers, dependency edges, generations, store-wide disabled-gap metadata, intents with `startDigest` + phase/progress revision/renewable deadlines, per-scope recent-snapshot set, touches; exclusive locking with startup write; dependency-aware cleanup; restore procedure.
- Disabled-mode startup guard for existing stores only, before traffic; no artifacts for never-enabled disabled installations; atomic re-enable quarantine of every pre-gap generation without deleting markers or retained payloads.
- Bounded RAM hot cache with row-version and generation/epoch validation.
- Replay planning (newest-record plan, uniform ancestor predicate) between translation and transport; synchronous dispatch critical section with universally quantified competitor check; single serialization of the dispatched payload.
- Client-frame-fed accumulator in `relayResponse.ts` with `finally` registered before the first write; cross-check; observation/publication before terminal frames; delivery-pending phase transition and resolution on `finish`; the single interruption rule.
- Progress-renewed upstream inactivity timeout (currently absent), initially 15 minutes; independent delivery/backpressure timers, bounded durable renewal cadence and expiry sweeps, current phase/revision/deadline race checks, no fixed total-age expiry.
- Restart/clock/restore retention barrier requiring a fresh full trusted monotonic idle window, default 30 days; replay stays available, deletion remains disabled until all guards pass.
- Optional future (not version one): a second scope-free SHA-256 chain over visible history used **only** for marker lookup, never for replay, would make poison/ambiguity markers cross-scope at ≈ 32 bytes per message. Listed as an option because it is a second index by the letter of section 1.
- Richer Responses types; schema/projection versioning with transactional migrations.
- Config, README limitations, acceptance gate.

## 15. Acceptance gate

**All entries below are required validation work, not claims that tests have run or passed. Revision 10 is not blanket-approved for deployment.** Historical corpus figures are evidence inputs; new memory, scope/width, timer and recovery measurements must be recorded from actual validation. Live protocol validation requires separate authorization.

1. **Recorded-session end-to-end prediction with a required nonzero verified hit rate.** Replay captured sessions offline; for every (client-response, next-request) pair assert `canonical(emitted) == canonical(resubmitted)` **without pre-normalizing either side outside the specified serializer**, covering `content: []`, singleton and empty text parts, **text-only turns with `tool_calls` absent vs `[]` on both SSE and JSON paths**, `index` present/absent, tool `name`, text+calls, **up to 11 parallel calls**. Assert a minimum fraction of verified matches **and that the replayed requests are eligible, not observe-only**.
2. Argument normalization pinned against fixtures, including `1.0`, exponents, > 2^53, `-0`, duplicate keys, non-ASCII escapes: divergence yields a miss, never a false match; invalid JSON → not admitted.
3. **Registry coverage:** every top-level field and header in the recorded corpus is classified; corpus replay yields eligible requests; `input`-shaped count re-checked (expected 0). An `input`-shaped body fences all scope rows sharing (credential, model, caller); without a caller field → (credential, model); registry-name then alias-name in one conversation → one fence per switch, replay resumes in the new generation.
4. **Serializer differential fixture:** the single count/emission serializer byte-equals sorted-key `JSON.stringify` over the whole recorded corpus plus adversarial strings (lone surrogates, `\u0000`–`\u001f`, `\u2028`/`\u2029`, non-BMP, keys requiring escapes). Assert pre-counted UTF-8 length equals emitted length and is written before each scope/message/capture frame's bytes; partitioning chunks does not change hashes. Canonicalization/eligibility: unknown fields, refusal parts, remote URLs → ineligible **but observed at a real prefix, no fence**; a request with an unclassified top-level field is observed in the **same** scope as its eligible twin and an older text-only record there becomes ambiguous. Pretty vs compact JSON → identical digests. Absent `index` eligible; inconsistent `index` ineligible.
5. Client-frame accumulator: `output_item.added` without `item.id`, refusal-only response → not admitted, observed with the client-frame identity.
6. Scope: model snapshot set (nothing observed → no skip; idle > 24 h then rotation → last-observed snapshot still admitted; stale → skipped not sent), `openai-beta`, key/caller/config changes, full ceiling-vector change → disjoint scopes **with old data intact, not deleted**.
7. Plan selection: transient reservation failure at turn 2 → replay resumes from turn 3; A(R) → B(no reasoning) → C(R) → C replays with A; poisoned ancestor → fallback to the newest record before it, next generation records that chain; ancestor with stale row version/poison/ambiguity → fallback; **stale-snapshot ancestor under a current dictating record → replayed** (inheritance).
8. Conflicts: same identity, different ciphertext/provenance, incl. oversized/unsupported/observe-only competitors.
9. **In-flight competitor:** B from P unresolved, C wants `(P → …)` → refused; C's own parent continuation not blocked; two unresolved intents at P, one the producer → refused; **competitor at an ancestor's position → refused**; an intent still past its current inactivity deadline after phase/progress revalidation → resolved-or-poisoned and no longer blocks. An actively renewed intent past its original dispatch-time deadline remains live.
10. **Blast radius:** Stop mid-stream in conversation X → position poisoned, no manual recovery, conversation Y in the same scope still replays. **Markers across fences:** poison at S in gen 1 → fence → record at S in gen 2 → resubmit kept E′ at S → miss; ambiguous in gen 1 → fence → same bytes in gen 2 → still not unique; fence with an unresolved intent → its position poisoned. Disabled-gap quarantine retains the same marker protection across all pre-gap scopes.
11. Interruption rule: `"Done."` cached at S, stream `"Done. Now…"`, connection dropped after `"Done."` → resubmit `"Done."` → miss. `response.failed` after partial text with `[DONE]` written → position poisoned (not identity-only). `response.incomplete` cutting a tool call mid-arguments → poisoned. Upstream 400 on a replay request before any output → poisoned, replayed blocks invalidated, ledger intact. If the text-only `incomplete` precision branch is enabled, a fixture pins Cursor's stored form for `finish_reason: length`.
12. Crash windows: before intent commit; after dispatch; after output commit before `finish`; between `[DONE]` and resolution; restart with multiple unresolved intents → bounded poisoning, intents resolved, other positions replay. Abort path: cleanup runs from `finally`. Crash while disabled or during gap consumption cannot expose pre-gap payloads on re-enable; late publication/renewal from an expired or quarantined generation is refused.
13. Live (authorized) protocol tests with `store: false` and `include` verified independently against the current baseline first; original encrypted items with `id`, `phase`, empty `summary`, reasoning + message + multiple calls, tool-result continuation, later user turn, missing-middle blocks; effective `reasoning.context`.
14. Deterministic ceilings: corpus replay → zero refusals with ≥ 4× headroom vs measured **canonical** maxima (history/scope bytes, envelopes, nodes, depth, width, candidate lookups counted alone); measure new scope/width maxima rather than extrapolating invented values. Synthetic conversation crossing a ceiling → skipped, no intent, no invalidation, other conversations unaffected; a 3,200-assistant-envelope history → no poison from the lookup count; a history within all ceilings whose **plan** would exceed the critical-section/plan bound → plan shrinks by fallback, the request still writes an intent and observes; **assert no intent-less skip is reachable from any cache-state-dependent quantity**; no hysteresis state exists.
15. DB budget against a 1,546-message history; critical section pre-checked and bounded; concurrent requests not stalled; aggregate digest-list cap refusal → reserved final-prefix guard poisons, not fences. Preflight/guard lease exhaustion cannot forward unobserved traffic. Verify bounded/coalesced progress-renewal writes and bounded expiry batches against multiple live and stalled intents; only stalled intents expire. Detailed phase/timer cases are in test 26.
16. Idle retention: day 0/29/59 semantics; idle-but-present record refreshes; ambiguous/poisoned/bypassed matches touch; config < 30 rejected. Even an old, otherwise reclaimable row cannot be deleted until the current startup/uncertainty barrier expires; replay and qualifying touches still work during that barrier.
17. Markers: ambiguous at S → payloads purged → third generation same bytes → not unique; poison at P and ambiguity at P (as `endDigest`) coexist without conflating — poisoning P does not invalidate the record ending at P; marker-budget exhaustion stops cache-affecting requests, drops nothing.
18. **Clock, restart and restore:** every startup, including a clean restart, blocks reclamation for a new full trusted monotonic idle window (default 30 days); UTC moving forward while stopped cannot bypass it. In-process forward/backward jumps or monotonic uncertainty disable deletion and renew the full barrier after trust returns. Restart just before barrier expiry resets it; repeated restarts deliberately overretain while replay continues. Older-snapshot restore quarantines generations and gets the same barrier. A persisted UTC purge deadline, an old cleanup batch, quota pressure or a recently restored wall clock cannot authorize deletion before the current monotonic barrier and normal retention predicates pass.
19. Quota exhaustion: admission stops, replay and observation continue; neither quarantine nor barrier-driven overretention permits emergency deletion of protected rows or markers.
20. Secret loss, schema migration, corrupt payload, **second owner gets `SQLITE_BUSY` on the startup write**, backup/WAL recovery, permissions. An existing store that cannot commit its disabled guard fails before traffic; disabled mode does not silently bypass ownership/integrity checks.
21. Determinism across restarts; key-order independence. Continuously enabled normal restart does not rotate generations, although it always renews the cleanup barrier.
22. Cross-scope re-send (tools change then back): σ1 records replay under σ1 only; Stop under σ1 then resume under σ2 documented as unprotected.
23. **Compaction/history rewrite:** Cursor drops or summarizes earlier messages → clean miss, then recovery via the `[]`-plan rebuild on the next turn.
24. Benchmarks: hashing/replay, disk latency, payload overhead, memory accounting, token usage, measured hit rate vs the reasoning-coverage ceiling. Include both count and emission passes and reserved scratch; report measurements, not inferred performance claims.
25. **Disabled lifecycle:** a never-enabled disabled run creates no DB/secret/WAL/SHM/directory and sends no new replay controls. With existing replay data, disabled startup commits the metadata-only gap before the first request without fetching payloads; disabled requests use ordinary translation. Re-enable atomically quarantines every pre-gap generation even across changed configuration/caller scopes, preserves markers/payloads/touches/dependencies, poisons unresolved pre-gap positions, and resumes only in new generations. Simulate crashes before/after the guard and inside recovery, repeated disabled starts, no-traffic disabled runs, second-owner/guard-write failure, and late pre-gap publication. No failure may consume the gap without quarantining old records. Never treat unreadable existing-store metadata as a never-enabled installation.
26. **Timer renewals and races:** with the initial 15-minute inactivity default, ten minutes of silence before first headers/bytes survives; silence beyond the current inactivity deadline expires. Streaming and JSON body progress repeatedly renew across the original deadline and across total durations longer than one timeout. SSE bytes without a complete event and bytes without visible output count as upstream progress. Coalesced durable writes do not let stale stored deadlines expire healthy work. Upstream completion starts a fresh delivery phase/deadline, independent of generation age; blocked client delivery expires despite upstream progress, while absence of any client output during upstream reasoning is not a delivery stall. Race progress renewal against a queued expiry callback, phase transition against the generation timer, `finish` against delivery expiry, and fence/gap recovery against renewal/publication; only the transition that wins current-state revalidation may act. Bounded sweeps expire stalled-not-all intents; successful or expired intents release timers, leases and dependency pins without resurrection.
27. **Allocation-first bounds:** adversarial wide shallow objects, nested wide objects, huge arrays, long escape-heavy keys/strings and large tools/instructions in scope stop at deterministic limits without first allocating oversized key arrays, sort scratch, escaped strings, canonical copies or scope clones. Instrument reservation-before-allocation for count and emission, including the sort routine's auxiliary storage and all simultaneously live nested workspaces. Assert fixed-chunk escaping, bounded per-message length metadata and aggregate N-request preflight/emission/guard accounting; digest-list refusal retains only the final digest on the guard path. Scope and capture use the same bounded serializer; a capture allocation failure observes/marks/poisons rather than taking an intent-less request skip. Count/emission length mismatch fails closed.

## 16. Review history and limitations

Rounds 1–3 (inherit + Opus, revisions 1–3, memory-only): complete-envelope hashing, whole-converter projection, dispatched-ancestry provenance, header-complete scope, dispatch-time validation, conflict observation independent of admission, bounded preparation. Both accepted revision 3.

Rounds 4–5 (inherit + Opus, revisions 4–5, persistence): SQLite authority, 30-day sliding retention, dependency-aware cleanup, delivery-pending intents, restore quarantine, clock protection. Both accepted revision 5.

Round 6 (Fable + Opus, fresh, revision 5, measured against the recorded corpus): both needs revision — the concept was safe but inert (erasure rule rejected ~99% of traffic) and self-disabling (scope fence on every Stop, 8 MiB ceiling). Revision 6 introduced the allowlist, argument normalization, prefix poisoning, non-invalidating ceilings, newest-record plan selection, in-flight competitor check, client-frame accumulator, long-lived markers.

Round 7 (Fable + Opus, revision 6): both confirmed the four core repairs sound (function-of-history argument, plan selection by induction, poisoning as superset within scope, exemption because a verified match is a delivery receipt) and returned needs revision on consistency:

- Markers were generation-scoped, so a fence re-opened resurrection → markers now keyed `(scope, digest)`; fences poison unresolved-intent positions.
- Canonicalization and eligibility were one step, so ineligible histories could not be observed and would have fenced → total canonicalization + separate allowlist.
- Hysteresis and raw-byte ceilings contradicted the function-of-history invariant → dropped hysteresis, canonical-quantity ceilings, ceiling vector in scope.
- `stream_options` (100% of requests) was unclassified → registry completed; test 3 asserts corpus coverage.
- Message ceiling 2,000 vs observed 1,546 → 6,400 with stated derivation.
- Ancestors escaped the competitor/row-version predicate → uniform predicate (snapshot inherited from the dictating record).
- `response.incomplete` stated two ways → single rule keyed on whether `finish` completed.
- Intent lifecycle unbounded → deadlines, startup resolution, upstream timeout.
- Minor: absent `index` valid, empty text part classified, `isWellFormed` rule dropped (stringify is injective), snapshot set with defined storage and empty state, `input`-shaped fence target defined, producing-intent column non-FK, exclusive lock acquired on first write, marker-budget policy, pseudocode poison-on-commit-failure, critical-section pre-check, descendant-recovery wording, compaction and parallel-call fixtures.

Round 8 (Fable + Opus, revision 7): both confirmed the consolidation introduced no structural contradiction; snapshot inheritance for ancestors is sound (checking ancestors individually would be wrong); total canonicalization is consistent with fingerprint normalization; generation-less markers are consistent with generation-scoped lookup. Fable: ready subject to gate conditional on one clause; Opus: needs revision, two one-line repairs. Consolidated into revision 8:

- `tool_calls: []` ≡ absent was missing; Cursor omits the key on 7% of assistant messages and never sends `[]`, so every text-only turn would have missed. The 280/280 pinning did not cover this shape; test 1 now forbids side normalization outside the serializer.
- One serializer implementation must byte-equal sorted-key `JSON.stringify`; differential fixture added (the injectivity argument depends on it).
- The “finish completed → identity only” branch relied on Cursor's unpinned storage of error/length-terminated streams → poison always, identity mark as addition, text-only `incomplete` as a fixture-gated exception; upstream-error-before-output defined.
- Markers keyed `(scope, kind, digest)`; poison read against `startDigest`, ambiguity/nonreplayable against `endDigest`.
- Scope seed from classified fields only; `input`-shaped fence target and caller fallback defined, co-occurrence restated as user behavior, partial protection disclosed.
- Snapshot set includes the last-observed snapshot of any age; described as a fail-open heuristic.
- Deterministic counts (lookups, plan size, descriptors) moved into the scope-seed vector; only leases, the digest-list cap and wall-clock are load-dependent.
- Ceilings as preparation bound for the walk, aggregate digest-list cap, digest computability qualified; canonical measurements quoted for all ceilings.
- Idle-based upstream timeout; recovery-after-poisoning wording; marker-budget “or fences” removed; scope-free marker chain listed as a future option.

Round 9 (Fable + Opus, revision 8): **both reviewers: ready for implementation subject to the acceptance gate**, each conditional on the same single clause, and both stating at that time that no further review round was needed. The clause: revision 8 had moved plan size and revalidation count into the deterministic-skip class, but these depend on cache state, not on `(scope, canonical history)` — a request could skip without intent or observation at a position where an earlier same-history request had been admitted, and with revalidations counted the lookup headroom was 3.4×, failing test 14's own ≥ 4× assertion. Revision 9 restricts deterministic counts to candidate lookups, bounds plan-derived quantities by shrinking the plan, and makes descriptors-per-record an admission limit. Editorial: node-count measurement corrected (16,702, not ≈ 250,000), `kind` added to the section 1 marker key, idle timeout defined for the JSON path, non-BMP wording, unobserved-generation limitation added to the inventory below, zero-frames-written relaxation recorded as optional.

Opus, for the record, reversed its round-8 position on the interruption rule: poisoning on every class is correct because what the relay wrote is not what Cursor stores for error- or length-terminated streams.

### Revision 10: four latest review fixes, implementation pending validation

The latest review requirements identify four gaps that the earlier conditional approval did not validate. This revision integrates them into the active contract, implementation map and acceptance gate; it does **not** claim a new reviewer approval or completed implementation:

1. **Disabled-mode continuity:** “disabled means no cache” was unsafe for an existing store because unobserved traffic could collide with old identities. Existing stores now require a metadata-only, store-wide disabled-gap guard before traffic; re-enable quarantines all pre-gap generations transactionally while retaining generation-less markers and retained data. Never-enabled disabled installations still create no DB or secret.
2. **Bounded serializer preparation:** emitting a length-prefixed canonical value while only discovering its length cannot implement the framing contract, and O(depth) omitted wide-object sorting/escaping and scope allocations. A single count/emission serializer now determines exact UTF-8 lengths before framing, with reserved and bounded width/sort/escape/scope scratch before allocation. Scope ceilings and new allocation tests are explicit; no new observed maxima or memory measurements are asserted.
3. **Restart-conservative retention:** in-process jump detection cannot certify wall-clock time while the relay was stopped. Every startup and new clock uncertainty renews a no-delete barrier for a full trusted monotonic idle window (default 30 days). Replay continues; frequent restarts may intentionally overretain indefinitely. UTC-only purge deadlines and clean restarts cannot waive the barrier.
4. **Phase-aware intent liveness:** an initial fixed intent deadline would expire healthy long-running generations despite upstream progress. Generation inactivity now renews on actual received progress, with an initial 15-minute default, bounded durable renewal writes and separate delivery/backpressure timers. Expiry revalidates phase, revision and deadline under the owner boundary and processes stalled intents in bounded batches, never all intents or all old intents merely because of total age.

Accepted limitations: identical visible histories within one scope — and across scopes — cannot identify the hidden branch; poison markers are scope-local; a fence after an `input`-shaped body protects existing records only, and a later new-generation record at an unobserved position can be matched by the unobserved branch; disabled-gap quarantine likewise cannot infer identities of output created while disabled; post-dispatch discoveries cannot recall work; local `finish` is not Cursor receipt; external rollback bypassing the restore procedure is undetectable; mutable model identity and month-old ciphertext acceptance are unverifiable; **only ~40–60% of responses carry reasoning, capping the hit rate**; quota exhaustion degrades hit rate rather than deleting data; startup/uncertainty barriers and frequent restarts may prevent cleanup indefinitely; genuinely silent work beyond the configured inactivity timeout is treated as stalled even if upstream might eventually complete; quadratic provenance; plaintext prompts/arguments on disk; the relay's pre-existing unbounded SSE/body buffering. Runtime validation remains mandatory; historical reviewer statements are not implementation or deployment approval.

## Sources

- https://developers.openai.com/api/docs/guides/reasoning
- https://developers.openai.com/api/docs/guides/conversation-state
- https://developers.openai.com/api/docs/guides/deployment-checklist#use-reasoningencrypted_content
- https://developers.openai.com/api/reference/resources/responses/streaming-events
- Local code and structural measurement of recorded logs on 2026-09-05; no raw prompts, credentials, encrypted blobs, or user identifiers are copied here. Revision 10 preserves those historical evidence inputs and adds no new runtime measurements.
