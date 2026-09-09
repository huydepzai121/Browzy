# Tasks

All tasks are intentionally unchecked. This change is specification-only. Scope excludes product implementation, archive, commit, GitNexus indexing, and edits to existing changes or `.claude/`.

## 0. Baseline And Investigatory Gates

- [x] 0.1 Re-read the current source and SDK typings for `companion.js`, `query-options.js`, `session/manager.js`, `mapping.js`, `can-use-tool.js`, `page-context.js`, `pending-recordings.js`, settings/profile modules, and the actual `shortcuts_execute` schema; record findings only inside this change's implementation evidence.
- [x] 0.2 Build an SDK fixture against the installed SDK and verify `resume`, `persistSession`, `forkSession`, cwd/session persistence, cancellation, partial results, `maxTurns`, `maxBudgetUsd`, `modelUsage`, aggregate usage exclusion of subagents, cost-table estimate semantics, `costBasis`, and total reset behavior after resume/clear.
- [x] 0.3 Stop implementation at the gate if SDK resume cannot preserve model context without browser-action replay, if missing sessions are not explicit, or if budget/usage semantics cannot be observed; do not add transcript prompt replay or promise a hard dollar ceiling. <- (verify: every later SDK option and ledger assumption has a pass/fail observation)
- [x] 0.4 Confirm repository test commands, host test-script limits, no-root-package assumption, live browser requirements, gateway requirements, and secret-free evidence storage.

## 1. P0 Minimum Document Identity Prerequisite

- [ ] 1.1 Verify the strongest feasible browser/content-script document identity using tab/frame identity, committed navigation signal, lifecycle state, and a per-document nonce across same-URL reload, SPA route changes, close, browser restart, and frames.
- [ ] 1.2 Define the minimum document binding and execution nonce required by send, lease acquisition, read, mutation, and approval validation; keep persistent workflow domain/scope constraints separate from per-execution nonces.
- [ ] 1.3 Define correlated navigation semantics: an authorized create/navigate action may commit an in-scope destination after destination domain/scope validation; unexpected replacement invalidates old refs, permissions, and approvals.
- [ ] 1.4 Add unit/integration tests for token creation, same-URL reload, SPA navigation, tab close, stale nonce, authorized navigation commit, unexpected replacement, and destination rejection. <- (verify: no URL-only fallback remains for a boundary that cannot establish identity)

## 2. P0 Session Continuity

- [ ] 2.1 Define versioned conversation metadata with secret-free app profile endpoint/model/credential-revision identity, skill identity, permission policy, SDK session reference, cwd/session schema identity, budget policy, lifecycle, usage epoch, and migration state.
- [ ] 2.2 Separate the app immutable provider/policy snapshot from the SDK persisted prompt/system snapshot; ensure every resumed turn obtains fresh page/document context and does not freeze a prior custom system prompt.
- [ ] 2.3 Implement atomic SDK-reference ownership, one active run per conversation, browser/native lease release, and deletion tombstones; deletion must remove SDK mapping, ledger, recording claims, and conversation-owned artifacts without late resurrection.
- [ ] 2.4 Resume only compatible SDK sessions; reject incompatible endpoint/model/skill/cwd/session identity or unavailable current credentials with explicit recovery/new-conversation UI and no historical-secret reconstruction.
- [ ] 2.5 Handle stop, restart, cancellation, partial turns, concurrent starts, missing sessions, legacy conversations, and unknown in-flight effects without replaying browser mutations. <- (verify: no failure path synthesizes memory from transcript events)
- [ ] 2.6 Add two-turn, restart, incompatible-selection, missing-session, credential-unavailable, fork/new-conversation, cancellation, partial-turn, race, late-unwind, and deletion tests.

## 3. P0 Evidence-Backed Approval

- [ ] 3.1 Derive the classifier matrix from actual qualified tool names and registered action schemas, including `click` versus `left_click`/`double_click`, key sequences/repeats, coordinates/refs, and the registered JavaScript script argument.
- [ ] 3.2 Resolve target evidence and pass normalized hints into `isSendClassCall`; define exact known, explicitly approvable-unknown, and unconditional-deny outcomes for keyboard submit, arbitrary JavaScript, unknown coordinates, and non-browser routes.
- [ ] 3.3 Bind approvals to run, domain, minimum document identity, execution nonce, normalized tool/action/arguments, target evidence, observed state, credential revision, and expiry; preserve borrowed-tab JavaScript rejection independently.
- [ ] 3.4 Revalidate browser evidence immediately before dispatch after Allow; invalidate changed target, document, domain, arguments, scope, nonce, or state. Keep approval controls exclusively in the panel, never in the controlled-page overlay. <- (verify: Allow cannot dispatch stale evidence)
- [ ] 3.5 Add adversarial tests for action-name mismatch, key repeats, indirect scripts, unknown targets, token replay, changed evidence, document replacement, scope change, and overlay/page-content approval attempts.
- [ ] 3.6 Run live approval QA for known coordinate/ref/keyboard/script cases and unknown cases; record conservative behavior without claiming semantic detection infallibility.

## 4. P0 Release Gate

- [ ] 4.1 Run continuity, minimum-document, approval, runtime, lease, permission, action-event, external-MCP, overlay, extraction, attachment, and skill regressions.
- [ ] 4.2 Run a real browser session covering active/background tabs, restart, stop, disconnect, authorized navigation, unexpected replacement, scope change, credential revocation, and deletion; confirm no action replay or unrelated overlay behavior. <- (verify: evidence distinguishes completed, partial, unknown, stale, and denied effects)
- [ ] 4.3 Keep P0 blocked until SDK, minimum-document, live approval, and outstanding active-change live gates pass; structural tests cannot substitute for live evidence.

## 5. P1 Usage And Budget

- [ ] 5.1 Define run-scoped and conversation-scoped limits, inheritance, reset rules, units, defaults, validation ranges, and UI copy; separate local wall-clock/model-turn admission from SDK budget behavior.
- [ ] 5.2 After the SDK gate, pass `maxTurns` and `maxBudgetUsd` with documented semantics; label `maxBudgetUsd` as an SDK estimated query-budget stop and never as a provider billing guarantee.
- [ ] 5.3 Implement epoch-based durable usage records keyed by SDK/session/turn/result identity, using cumulative `modelUsage` deltas so subagent usage is counted where available; do not use a local tool counter as a proxy for SDK-call control.
- [ ] 5.4 Reconcile resume/clear reset totals, retries, cancellation, partial results, late results, unknown intervals, and subagent model usage without double counting or fabricated zero cost. <- (verify: each ledger row has epoch, stable dedupe identity, source, evidence status, and no false billing claim)
- [ ] 5.5 Render local limits, SDK estimates, external billing evidence, pending, and unknown distinctly; disable only actions actually blocked by a verified local limit or provider/session state.
- [ ] 5.6 Test run/conversation reset and inheritance, SDK estimated-budget stop, local admission, restart, dedupe, cancellation, late results, subagents, unknown pricing, and a real configured gateway's usage semantics.

## 6. P1 Recording Attachment And Model Input

- [ ] 6.1 Define versioned recording attachment protocol and durable states `selected`, `attached`, `submitted`, `included`, `unknown`, and `failed`, with owner, conversation, idempotency key, integrity, and crash/cancel metadata.
- [ ] 6.2 Define the new scoped model-readable delivery path, choosing bounded redacted/truncated trace/transcript content blocks or a read-only recording tool; specify exact size limits, ownership checks, and failure acknowledgements. Do not claim the pending-reference channel delivers model content.
- [ ] 6.3 Implement selected idle-conversation claim, completion routing to the selected owner when no run is active, atomic pending reconciliation, and conflict/idempotency handling without arbitrary active-run routing.
- [ ] 6.4 Include recording content in the next model turn only after successful submission and delivery acknowledgement; preserve `submitted`/`unknown` across crash or cancellation until reconciled. <- (verify: transcript `included` is impossible without model-input evidence)
- [ ] 6.5 Add tests for missing/oversized/redacted files, owner mismatch, duplicate/racing claims, lease contention, no-active-run completion, crash/cancel, deletion, restart, and exact model input.
- [ ] 6.6 Run live recording attach/model-input QA and a failed/missing artifact case; block release when only metadata/UI attachment is demonstrated.

## 7. P1 Advanced Document And Context UX

- [ ] 7.1 Extend page-context UI, queued leases, pin/unpin, permissions, approvals, extraction results, and workflow execution with the minimum document identity from section 1.
- [ ] 7.2 Revalidate at send, lease acquisition, every read/extraction, and every mutation; preserve original source identity for captured content and distinguish refreshed, incomplete, replacement, and unavailable results.
- [ ] 7.3 Add tests for queued tab changes, pin changes, closed tabs, SPA routes, reloads, stale permissions, read guards, mutation guards, and correlated navigation.
- [ ] 7.4 Run live browser QA at 320/400/480 widths and light/dark themes while reloading, routing, closing, pinning, and switching tabs. <- (verify: no operation reads or acts on an unexpected replacement document)

## 8. P1 Release Gate

- [ ] 8.1 Run P1 usage, recording, document, panel, settings, attachment, lease, extraction, runtime, and external-MCP regressions.
- [ ] 8.2 Complete the outstanding live/gateway/accessibility tasks from `adopt-panel-design-and-image-attachments` and live overlay tasks from `repair-overlay-mount-and-visibility` as dependencies without editing those changes.
- [ ] 8.3 Require real provider usage evidence, recording model-input evidence, document reload/SPA evidence, and 320/400/480 light/dark keyboard/a11y evidence before P1 release; unknown provider billing remains unknown. <- (verify: no structural result is reported as live completion)

## 9. P2 Provider Profiles

- [ ] 9.1 Define named profile schema, secret-free identity/revision, default migration, model catalog, capability-test key, endpoint/model conversation binding, and export redaction.
- [ ] 9.2 Extend settings CRUD/select UI and protocol over the existing backend; store runtime credentials only in the OS store or explicitly labeled memory-only mode.
- [ ] 9.3 Snapshot profile endpoint/model/skill identity and capability state at run start; ordinary nonsecret edits affect future runs, while replacement/removal/revocation cancels affected active work and takes precedence over continuation.
- [ ] 9.4 Reject incompatible profile selection before SDK resume and direct the user to new conversation; never reconstruct an unavailable old credential or conflate app snapshot with SDK prompt snapshot.
- [ ] 9.5 Test migration, CRUD, selection, duplicate identities, secret clearing after submit, secure-storage failure, capability invalidation, active-run cancellation/immutability, deletion, and OpenAI/Gemini exclusion.
- [ ] 9.6 Run live Anthropic-compatible capability tests and profile deletion/revocation UI checks without exposing secrets. <- (verify: secret-free profile/session/workflow records)

## 10. P2 Reusable Workflows And MCP

- [ ] 10.1 Define exact versioned workflow fields: id, version, owner, name, description, parameter schema, domain/document constraints, allowlisted steps, provenance, enabled state, and timestamps.
- [ ] 10.2 Define additive versioned MCP schemas for trusted CRUD management, read-only agent discovery, async execution identity/status/cancel, and `shortcuts_execute` compatibility with its actual `tabId`, optional `shortcutId`, and `command` fields; do not invent parameter/version fields in the legacy operation.
- [ ] 10.3 Implement exact normalized host/domain matching, parameter validation/redaction, ownership/portability, migration, stale-peer errors, and separate execution nonces from persistent workflow scope.
- [ ] 10.4 Define MCP-to-panel handoff and no-panel/no-profile result; preserve ordinary MCP independence and acquire/release browser lease without deadlock. Agent discovery MUST NOT create management or approval authority.
- [ ] 10.5 Route workflow execution through existing tool/skill adapter, document guard, evidence-backed approval, profile/skill snapshot, cancellation, usage policy, and lease; add no alternate executor or bypass. <- (verify: identical sensitive steps receive identical policy decisions)
- [ ] 10.6 Allow recording-derived drafts only when every step, parameter, domain, and document is fully resolved; otherwise return a specific incomplete-evidence reason.
- [ ] 10.7 Test schema/CRUD/ownership/import/version errors, substring-domain rejection, parameters, secret redaction, stale documents, approval, cancellation, budget, async status/cancel, no-panel/no-profile, legacy MCP independence, and stale companions.
- [ ] 10.8 Run live sidepanel and MCP workflow discovery, review, ordinary/sensitive execution, document change, restart, cancellation, and recording-draft QA. <- (verify: advertisement alone cannot execute or manage a workflow)

## 11. Final UI, Security, And Release Verification

- [ ] 11.1 Integrate continuity, usage, recording, document, profile, approval, and workflow states without regressing overlay, image attachment, timeline, prompt enhancement, skill picker, recording controls, microphone permission, or transcription credentials.
- [ ] 11.2 Verify keyboard focus, accessible names, polite announcements, reduced motion, contrast, no horizontal scroll, and unclipped text at 320/400/480 CSS pixels in light and dark themes across empty, active, approval, exhausted, stale-context, profile, recording, and workflow states. <- (verify: recording start/stop and workflow async cancel remain reachable)
- [ ] 11.3 Run all affected repository regression commands, targeted unit/integration suites, live browser/provider checks, and changed-file boundary review.
- [ ] 11.4 Perform security review for secret leakage, workflow authority escalation, approval bypass, document confusion, replay, path traversal, ownership races, lease deadlock, and deletion cleanup.
- [ ] 11.5 Leave every task unchecked until its evidence exists and keep release gates blocked when live/provider checks are unavailable. <- (verify: final report maps each review issue to evidence or an explicit residual gate)
