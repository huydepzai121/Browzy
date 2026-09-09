// Conversation lifecycle: start/resume/new/stop, one active run per
// conversation, and companion-restart recovery (task 3.5).
//
// Owns nothing about the SDK or the browser directly — it wires together
// storage/transcript-store.js (durable, sequenced events), a shared
// BrowserLease (serializes runs across conversations) and ApprovalRegistry,
// and hands out Run objects (session/run.js) that the companion actually
// drives through the SDK.

import crypto from "node:crypto";

import { Run, RUN_STATES } from "./run.js";
import { PendingRecordingsStore } from "../storage/pending-recordings.js";
import { sanitizeActionEvent, PerStreamSeqTracker } from "../storage/action-timeline.js";

export function newConversationId() {
  return `conv_${crypto.randomBytes(9).toString("hex")}`;
}

export class SessionManager {
  /**
   * @param {object} deps
   * @param {import("../storage/transcript-store.js").TranscriptStore} deps.store
   * @param {import("../broker/browser-lease.js").BrowserLease} deps.lease
   * @param {import("../policy/approvals.js").ApprovalRegistry} deps.approvals
   * @param {import("../storage/pending-recordings.js").PendingRecordingsStore} [deps.pendingRecordings] -
   *   defaults to a real store over the standard agent-root path; injectable
   *   so tests can point it at a scratch file. Optional/additive: existing
   *   call sites that never pass this dep are unaffected unless they call
   *   recordRecordingComplete()/listPendingRecordings() (task 6.3).
   */
  constructor({ store, lease, approvals, pendingRecordings, releaseNativeLease }) {
    this.store = store;
    this.lease = lease;
    this.approvals = approvals;
    // Passed down to every Run so finishing one also hands the shared browser
    // bridge back to host/native-host.js's guard — see Run's own note. Left
    // undefined in tests, where there is no pipe to talk to.
    this.releaseNativeLease = releaseNativeLease;
    this.pendingRecordings = pendingRecordings || new PendingRecordingsStore();
    this._activeRuns = new Map(); // conversationId -> Run
    // Explicit-delete tombstones (task: close reports/05-panel-evidence.md's
    // "No DELETE_CONVERSATION message type" gap, "handled explicitly, not
    // left racy" requirement). Deleting a conversation only synchronously
    // stops its Run (run.stop() aborts the SDK call and emits run_stopped
    // immediately), but the SDK's own query() generator notices the abort
    // and unwinds ASYNCHRONOUSLY — its `finally` block still calls
    // finishRun()/emits further events after deleteConversation() has
    // already removed the on-disk directory. Without this guard,
    // TranscriptStore.appendEvent()'s auto-vivify fallback
    // (`loadMeta() || createConversation()`) and updateMeta()'s
    // read-or-default-then-atomicWrite would silently resurrect a
    // half-formed conversation directory out from under a delete the panel
    // already told the user succeeded. Membership is checked by every
    // store-write path this class owns (see startRun's onEvent sink,
    // finishRun, setSkillsBinding) before it touches the store for a given
    // conversationId. In-memory only, per companion process — a fresh
    // process's disk-backed listConversations() simply won't list a
    // genuinely deleted conversation at all, so nothing needs to persist
    // this across a restart.
    this._deletedConversations = new Set();
    // Action-timeline reconnect dedup (task 5.10's host half): one
    // PerStreamSeqTracker per conversation, lazily seeded from this
    // conversation's own persisted history the first time it is touched in
    // THIS process (see recordActionEvents() below) — never simply reset to
    // empty on a fresh companion process, which would otherwise accept a
    // redelivered batch as new after a restart.
    this._actionEventCursors = new Map(); // conversationId -> PerStreamSeqTracker
    this._actionEventCursorsSeeded = new Set();
  }

  newConversation(meta = {}) {
    const conversationId = newConversationId();
    // Defensive: newConversationId() is a fresh random id (crypto.randomBytes(9),
    // 2^72 space) so colliding with a previously-deleted id is not a realistic
    // event, but a conversationId must never be permanently unwritable if it
    // somehow did collide.
    this._deletedConversations.delete(conversationId);
    this.store.createConversation(conversationId, meta);
    return conversationId;
  }

  listConversations() {
    return this.store.listConversations();
  }

  /**
   * Wire-facing summaries for the LIST_CONVERSATIONS protocol message (see
   * host/agent/companion.js's _handleListConversations()). Every field the
   * panel's history screen needs to render and reopen a conversation,
   * including the interrupted flag that survives a companion restart
   * (resumeConversation()/recoverAfterRestart() below) and whether THIS
   * process currently has that conversation's run actively queued or
   * running — in-memory, per-process, which is exactly right: after a
   * restart recoverAfterRestart() already clears any stale activeRunId and
   * sets interrupted instead of leaving a ghost "active" conversation for a
   * process that no longer exists.
   *
   * @returns {Array<{conversationId:string, createdAt:number, updatedAt:number, interrupted:boolean, hasActiveRun:boolean}>}
   */
  conversationSummaries() {
    return this.store.listConversations().map((meta) => ({
      conversationId: meta.conversationId,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      interrupted: Boolean(meta.interrupted),
      hasActiveRun: this.hasActiveRun(meta.conversationId)
    }));
  }

  /** Whether a conversation with this id currently exists on disk (not
   * deleted). Used by companion.js to reply unknown_conversation rather than
   * a false "deleted:true" for an id that was never valid. */
  hasConversation(conversationId) {
    return Boolean(this.store.loadMeta(conversationId));
  }

  /**
   * Reconstruct session display from disk (spec: "Resume after restart"):
   * returns the transcript snapshot and marks any run that was active at
   * last-known state as interrupted. Never resumes browser actions.
   */
  resumeConversation(conversationId, afterSeq = 0) {
    const meta = this.store.loadMeta(conversationId);
    if (!meta) throw new Error(`unknown conversation: ${conversationId}`);
    if (meta.activeRunId && !this._activeRuns.has(conversationId)) {
      this.store.updateMeta(conversationId, { activeRunId: null, interrupted: true });
      this.store.appendEvent(conversationId, {
        type: "run_interrupted_by_restart",
        runId: meta.activeRunId
      });
    }
    return this.store.snapshot(conversationId, afterSeq);
  }

  snapshotSince(conversationId, afterSeq = 0) {
    return this.store.snapshot(conversationId, afterSeq);
  }

  hasActiveRun(conversationId) {
    const run = this._activeRuns.get(conversationId);
    return !!run && (run.state === RUN_STATES.QUEUED || run.state === RUN_STATES.RUNNING);
  }

  activeRun(conversationId) {
    return this._activeRuns.get(conversationId) || null;
  }

  /**
   * @throws if the conversation already has an active run (spec: "prevent
   *   more than one active run per conversation").
   */
  startRun(conversationId, { tabScope = "any" } = {}) {
    if (!this.store.loadMeta(conversationId)) throw new Error(`unknown conversation: ${conversationId}`);
    if (this.hasActiveRun(conversationId)) {
      throw new Error(`conversation ${conversationId} already has an active run`);
    }
    const run = new Run({
      conversationId,
      lease: this.lease,
      approvals: this.approvals,
      tabScope,
      releaseNativeLease: this.releaseNativeLease,
      // Guarded against the explicit-delete race documented on
      // this._deletedConversations above: an event emitted after this
      // conversation was deleted (e.g. the SDK query() generator's `finally`
      // unwinding asynchronously, after abortController.abort() but before
      // deleteConversation() returned) is dropped rather than resurrecting
      // the just-removed on-disk directory.
      onEvent: (event) => {
        if (this._deletedConversations.has(conversationId)) return;
        this.store.appendEvent(conversationId, event);
      }
    });
    this._activeRuns.set(conversationId, run);
    this.store.updateMeta(conversationId, { activeRunId: run.runId, interrupted: false });
    this.store.appendEvent(conversationId, { type: "run_created", runId: run.runId, tabScope });
    return run;
  }

  /**
   * The skills session this conversation is bound to (task 7.2 / spec
   * "Skill version and lifecycle isolation"): `{ cwd, skillsDir,
   * allowedSkillNames, catalogSnapshot, skillOverrides }`, first computed by
   * host/agent/companion.js's `_bindSkillsForRun()` on the conversation's
   * FIRST run and persisted here so every later run of the SAME conversation
   * reuses the identical bound snapshot rather than re-deriving from a
   * possibly-changed live catalog — this is what makes "a skill refreshed or
   * disabled mid-conversation does not silently change a running
   * conversation" true across turns, not just within one run.
   *
   * @returns {object|null}
   */
  getSkillsBinding(conversationId) {
    const meta = this.store.loadMeta(conversationId);
    return (meta && meta.skillsBinding) || null;
  }

  /** Persist this conversation's first-run skills binding (see getSkillsBinding). */
  setSkillsBinding(conversationId, binding) {
    if (this._deletedConversations.has(conversationId)) return; // see this._deletedConversations' header comment
    this.store.updateMeta(conversationId, { skillsBinding: binding });
  }

  /**
   * Every currently active (queued or running) run started by THIS process
   * for the given profileId — used to cancel runs when their credential is
   * revoked (host/agent/companion.js's onCredentialRevoked wiring; design.md
   * decision 4: "removing a credential ... cancels associated runs"). A run
   * is tagged with the profileId it was started with by companion.js's
   * _handleStart() (`run.profileId = profileId`) before this can match it.
   *
   * @param {string} profileId
   * @returns {Array<{conversationId: string, run: Run}>}
   */
  activeRunsForProfile(profileId) {
    const matches = [];
    for (const [conversationId, run] of this._activeRuns) {
      if (run.profileId === profileId && (run.state === RUN_STATES.QUEUED || run.state === RUN_STATES.RUNNING)) {
        matches.push({ conversationId, run });
      }
    }
    return matches;
  }

  stopRun(conversationId, reason = "user_stop") {
    const run = this._activeRuns.get(conversationId);
    if (!run) return false;
    if (run.state === RUN_STATES.STOPPED || run.state === RUN_STATES.DONE) return false;
    run.stop(reason);
    if (!this._deletedConversations.has(conversationId)) {
      this.store.updateMeta(conversationId, { activeRunId: null });
    }
    return true;
  }

  finishRun(conversationId) {
    const run = this._activeRuns.get(conversationId);
    if (run) run.markDone();
    this._activeRuns.delete(conversationId);
    if (this._deletedConversations.has(conversationId)) return; // see this._deletedConversations' header comment
    this.store.updateMeta(conversationId, { activeRunId: null });
  }

  /**
   * Explicit local deletion (spec 5.3: "explicit local history deletion"),
   * closing reports/05-panel-evidence.md's "No DELETE_CONVERSATION message
   * type" gap. Removes only this app's own conversation data and SDK
   * artifacts (host/agent/storage/transcript-store.js's deleteConversation:
   * "Recordings live in a separate tree ... and are untouched" — design.md
   * section 5's separate retention for recorded demonstrations holds).
   *
   * "Handled explicitly, not left racy" for an active run: the run is
   * stopped (aborting the SDK call and invalidating its approvals)
   * SYNCHRONOUSLY, before anything on disk is removed, and this
   * conversationId is tombstoned (this._deletedConversations) so any event
   * the aborting run's query() loop still emits asynchronously afterward is
   * dropped rather than resurrecting the just-deleted directory — see the
   * field's own header comment and the guards in startRun/finishRun/
   * setSkillsBinding above.
   *
   * @returns {{ hadActiveRun: boolean }}
   */
  deleteConversation(conversationId) {
    const hadActiveRun = this.hasActiveRun(conversationId);
    this.stopRun(conversationId, "conversation_deleted");
    this._activeRuns.delete(conversationId);
    this._deletedConversations.add(conversationId);
    this._actionEventCursors.delete(conversationId);
    this._actionEventCursorsSeeded.delete(conversationId);
    this.store.deleteConversation(conversationId);
    return { hadActiveRun };
  }

  /**
   * The conversation a just-finished narrated recording should be attached
   * to live, or null when none is unambiguously "active" (task 6.3 / spec:
   * "Recording finishes without an open conversation"). Priority:
   *   1. Whichever conversation's run currently holds the shared browser
   *      lease — it is the one actually driving the SAME browser bridge the
   *      recording was just captured through, so it is the least ambiguous
   *      target when it exists.
   *   2. If nothing holds the lease (e.g. between actions) but exactly one
   *      conversation has an active run (queued or running), that one.
   *   3. Otherwise (nothing active, or more than one candidate with no
   *      lease holder to disambiguate them) — null, meaning "no SDK run is
   *      active" per the spec scenario, so the caller persists it instead.
   */
  activeConversationIdForRecording() {
    const holder = this.lease.currentHolder();
    if (holder && holder.conversationId && this.hasActiveRun(holder.conversationId)) {
      return holder.conversationId;
    }
    const activeIds = [];
    for (const [conversationId, run] of this._activeRuns) {
      if (run.state === RUN_STATES.QUEUED || run.state === RUN_STATES.RUNNING) activeIds.push(conversationId);
    }
    return activeIds.length === 1 ? activeIds[0] : null;
  }

  /**
   * Route one finished narrated recording (task 6.3): append it to the
   * active conversation's transcript when one exists, else persist it for
   * later attachment. Idempotent by recordingId in both branches, so a
   * re-delivered event (companion restart, extension retry) never appends
   * or lists the same recording twice — a reconnecting panel resyncing via
   * its normal afterSeq cursor therefore never sees a duplicate either.
   *
   * @returns {string|null} the conversationId it was attached to, or null
   *   when it was persisted to the pending list instead.
   */
  recordRecordingComplete(recording) {
    const conversationId = this.activeConversationIdForRecording();
    if (!conversationId) {
      this.pendingRecordings.add(recording);
      return null;
    }
    const alreadyRecorded = this.store
      .eventsAfter(conversationId, 0)
      .some((e) => e.type === "recording_complete" && e.recordingId === recording.recordingId);
    if (!alreadyRecorded) {
      this.store.appendEvent(conversationId, { type: "recording_complete", ...recording });
    }
    return conversationId;
  }

  /** Every recording still waiting for a conversation to claim it. */
  listPendingRecordings() {
    return this.pendingRecordings.list();
  }

  /**
   * Persist a batch of raw wire action-timeline events (task 5.10's host
   * half; design.md decision 5c) into this conversation's own transcript,
   * as `{type: "action_event", event}` entries — reusing the SAME durable,
   * sequenced per-conversation log (and its existing snapshot/afterSeq
   * resync machinery) every other session-level fact already goes through,
   * rather than inventing a second storage/resync mechanism. Every event is
   * independently validated + allowlist-copied by sanitizeActionEvent()
   * (storage/action-timeline.js) before it can reach disk — a malformed or
   * disallowed event is rejected, never partially stored. A per-conversation
   * PerStreamSeqTracker (lazily seeded from this conversation's OWN already-
   * persisted action_event history the first time it is touched by this
   * process) rejects anything at or below a stream's highest accepted `seq`,
   * so a redelivered/replayed batch — a retried native message, a companion
   * restart racing an in-flight send — can never create a duplicate row,
   * even across a restart.
   *
   * @param {string} conversationId
   * @param {Array<object>} rawEvents
   * @returns {{stored: number, rejected: number, duplicate: number}}
   * @throws if conversationId is unknown
   */
  recordActionEvents(conversationId, rawEvents) {
    if (!this.store.loadMeta(conversationId)) throw new Error(`unknown conversation: ${conversationId}`);

    let tracker = this._actionEventCursors.get(conversationId);
    if (!tracker) {
      tracker = new PerStreamSeqTracker();
      this._actionEventCursors.set(conversationId, tracker);
    }
    if (!this._actionEventCursorsSeeded.has(conversationId)) {
      // Reconstruct "highest seq already stored per stream" from this
      // conversation's own persisted log. eventsAfter(id, 0) returns the
      // most-recent slice when the log exceeds its snapshot cap — since
      // seq is strictly increasing at append time, the most-recent slice
      // still contains every stream's true current maximum.
      for (const stored of this.store.eventsAfter(conversationId, 0)) {
        const ev = stored && stored.type === "action_event" ? stored.event : null;
        if (ev && typeof ev.streamKey === "string" && Number.isInteger(ev.seq)) {
          tracker.seed(ev.streamKey, ev.seq);
        }
      }
      this._actionEventCursorsSeeded.add(conversationId);
    }

    let stored = 0;
    let rejected = 0;
    let duplicate = 0;
    for (const raw of Array.isArray(rawEvents) ? rawEvents : []) {
      const result = sanitizeActionEvent(raw);
      if (!result.ok) {
        rejected++;
        continue;
      }
      const { event } = result;
      if (!tracker.accept(event.streamKey, event.seq)) {
        duplicate++;
        continue;
      }
      if (this._deletedConversations.has(conversationId)) continue; // see this._deletedConversations' header comment
      this.store.appendEvent(conversationId, { type: "action_event", event });
      stored++;
    }
    return { stored, rejected, duplicate };
  }

  /**
   * Companion restart recovery: mark every conversation that has an
   * unresolved activeRunId (the process died before finishRun/stopRun ever
   * ran) as interrupted. Idempotent; safe to call once at companion startup
   * before any conversation is resumed interactively.
   */
  recoverAfterRestart() {
    const recovered = [];
    for (const meta of this.store.listConversations()) {
      if (meta.activeRunId) {
        this.store.updateMeta(meta.conversationId, { activeRunId: null, interrupted: true });
        this.store.appendEvent(meta.conversationId, {
          type: "run_interrupted_by_restart",
          runId: meta.activeRunId
        });
        recovered.push(meta.conversationId);
      }
    }
    return recovered;
  }
}
