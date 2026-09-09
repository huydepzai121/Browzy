// Versioned conversation metadata schema (tasks.md 2.1) and the app/SDK
// snapshot boundary it exists to make explicit (tasks.md 2.2).
//
// design.md decision 2: "Extend conversation metadata with a secret-free app
// profile identity (profile id, endpoint/model identity, credential
// revision), skill identity, permission policy, SDK reference, session
// schema version, lifecycle status, and budget policy... Do not conflate
// this app snapshot with the SDK's persisted prompt/system snapshot."
//
// The "SDK persisted prompt/system snapshot" this must never be conflated
// with is a REAL, named SDK mechanism, not a metaphor: the pinned SDK's own
// `Options.systemPrompt.snapshot` field (sdk.d.ts ~2192-2220) — "whether the
// conversation's system prompt is recorded once ... and reused verbatim on
// every later request and resume/continue, instead of being rendered fresh
// each time." This project's `systemPrompt` text always embeds the CURRENT
// run's bound page/document context (query-options.js's
// `renderPageContextSystemPrompt`), so recording it would freeze a stale
// page/document identity across every future resumed turn — exactly what
// decision 2 forbids ("every resumed turn must rebuild fresh page context
// ... must not freeze a prior custom system prompt"). query-options.js's
// `buildIsolatedOptions()` sets `snapshot: false` explicitly for this reason
// (see its own comment) — this module owns the APP-side half of the
// boundary: everything here is secret-free, page-context-free, and prompt-
// text-free by construction. Nothing in this module ever stores an API key,
// a page URL/tabId, or system-prompt text; the SDK's own session reference
// (`sdkSessionRef` below) is recorded only as an opaque id, never resolved
// or reconstructed from here.
//
// Scope note (osf-apply, tasks 2.1/2.2 only): this module defines the
// schema, its migration, and the app-snapshot builders. It does NOT
// implement atomic SDK-reference ownership, one-active-run-per-conversation
// enforcement, deletion tombstones (tasks.md 2.3), or resume-compatibility
// rejection (2.4) — `sdkSessionRef` and `budgetPolicy` are reserved,
// versioned fields a later group populates; they stay null/default here.

import { SESSION_SKILLS_PLUGIN_NAME } from "../skills/session-workspace.js";

export const CONVERSATION_METADATA_SCHEMA_VERSION = 1;

export const LIFECYCLE = Object.freeze({
  ACTIVE: "active",
  // Reserved for task 2.3's tombstone semantics; never set by this module.
  DELETED: "deleted"
});

// Advisory-only defaults (design.md decision 4: a local wall-clock/turn
// counter stays authoritative; SDK `maxTurns`/`maxBudgetUsd` are best-effort
// on top of it — group 5's job to populate real values). `null` means
// "no policy configured yet", never a fabricated limit.
export const DEFAULT_BUDGET_POLICY = Object.freeze({
  maxTurns: null,
  maxBudgetUsd: null,
  wallClockDeadlineMs: null
});

function freshMigrationState({ backfilled, legacy }) {
  return {
    schemaVersion: CONVERSATION_METADATA_SCHEMA_VERSION,
    backfilled: Boolean(backfilled),
    backfilledAt: backfilled ? Date.now() : null,
    legacy: Boolean(legacy)
  };
}

/**
 * The envelope a brand-new conversation gets at creation time (before any
 * run has ever started, so app profile / skill / permission identity are
 * not knowable yet — same lazy "bound on first run" pattern already used by
 * SessionManager.getSkillsBinding/setSkillsBinding).
 */
export function initConversationMetadataEnvelope() {
  return {
    schemaVersion: CONVERSATION_METADATA_SCHEMA_VERSION,
    appProfile: null,
    sessionSchemaIdentity: null,
    permissionPolicy: null,
    // { sessionId, persistSession, forkedFrom } once a later group wires
    // SDK-level `resume` — reserved, never populated here.
    sdkSessionRef: null,
    budgetPolicy: { ...DEFAULT_BUDGET_POLICY },
    lifecycle: LIFECYCLE.ACTIVE,
    usageEpoch: 0,
    migrationState: freshMigrationState({ backfilled: false, legacy: false })
  };
}

/**
 * Secret-free app profile identity (design.md decision 2's exact field
 * list): profile id, endpoint/model identity, credential revision. NEVER
 * accepts or stores `env`/an API key — callers must destructure only the
 * fields listed here out of a resolved profile snapshot.
 *
 * @param {object} params
 * @param {string|null} [params.profileId]
 * @param {string|null} [params.baseUrl] - non-secret endpoint URL (the
 *   snapshot's `env.ANTHROPIC_BASE_URL`), never the API key.
 * @param {string|null} [params.modelId]
 * @param {number|null} [params.credentialRevision] - from
 *   host/agent/settings/profile.js's `credentialRevision` (bumped on
 *   setCredential/removeCredential); `null` (never `0`) when the resolved
 *   snapshot did not carry one (e.g. a test double's minimal fake).
 */
export function buildAppProfileIdentity({ profileId = null, baseUrl = null, modelId = null, credentialRevision = null } = {}) {
  return {
    profileId: profileId ?? null,
    endpoint: baseUrl ?? null,
    modelId: modelId ?? null,
    credentialRevision: credentialRevision ?? null
  };
}

/**
 * The "cwd/session schema identity" input list gate-0.2's own evidence
 * report names as load-bearing for a future resume-compatibility check
 * (tasks.md 2.4) — reproduced here exactly, not re-derived:
 *   1. cwd (the session's skills workspace directory)
 *   2. the materialized plugin directory + its fixed plugin name
 *   3. allowedSkillNames in plugin-qualified form
 *   4. skillOverrides, keyed the same way
 *   5. settingSources (fixed `[]`, per query-options.js's isolation
 *      contract — never varies, included for completeness/comparability)
 *
 * Derived from a conversation's own `skillsBinding` (SessionManager's
 * existing `getSkillsBinding()` shape) so this never re-implements or
 * drifts from what buildSessionSkills() actually materialized. Tolerates
 * both the current (plugin-era) and a legacy pre-plugin `skillsBinding`
 * shape (no `pluginDir`/`configDir`) — see migrateConversationMetadata()'s
 * own real-fixture tests. `pluginName` is reported only when this binding
 * actually has a `pluginDir` — a legacy record never went through the
 * plugin mechanism at all, so attaching today's fixed plugin name to it
 * would misrepresent what was actually materialized for that conversation.
 *
 * @param {object|null} skillsBinding
 * @returns {object|null} null when no skillsBinding exists yet (conversation
 *   has never had a run).
 */
export function buildSessionSchemaIdentity(skillsBinding) {
  if (!skillsBinding || typeof skillsBinding !== "object") return null;
  return {
    cwd: skillsBinding.cwd ?? null,
    pluginDir: skillsBinding.pluginDir ?? null,
    pluginName: skillsBinding.pluginDir ? SESSION_SKILLS_PLUGIN_NAME : null,
    configDir: skillsBinding.configDir ?? null,
    allowedSkillNames: Array.isArray(skillsBinding.allowedSkillNames) ? [...skillsBinding.allowedSkillNames].sort() : [],
    skillOverrides: { ...(skillsBinding.skillOverrides || {}) },
    // Fixed today (query-options.js's isolation contract never widens this),
    // never derived from the binding itself.
    settingSources: []
  };
}

/**
 * A self-maintaining identity of the permission policy actually applied to
 * a run's constructed `query()` Options (host/agent/tools/query-options.js's
 * `buildIsolatedOptions()` return value) — sorted so two runs with the same
 * effective policy compare equal regardless of construction order. Deriving
 * this FROM the real options object (rather than a hand-maintained constant)
 * means it can never silently drift from what the run actually got.
 *
 * @param {object|null} options - a buildIsolatedOptions() result
 * @returns {object|null}
 */
export function buildPermissionPolicyIdentity(options) {
  if (!options || typeof options !== "object") return null;
  const sortedCopy = (arr) => (Array.isArray(arr) ? [...arr].sort() : []);
  return {
    tools: sortedCopy(options.tools),
    allowedTools: sortedCopy(options.allowedTools),
    disallowedTools: sortedCopy(options.disallowedTools)
  };
}

/**
 * Normalize an on-disk conversation meta record (TranscriptStore's
 * `loadMeta()` shape) into the current schema envelope, WITHOUT mutating the
 * input. Idempotent: an already-current envelope is returned by reference,
 * unchanged, so a caller can cheaply detect "no migration was needed" via
 * `=== ` and skip a redundant disk write.
 *
 * Hard rule (this change's own non-negotiable): a legacy record's
 * `appProfile` is NEVER reconstructed — no historical-secret/identity
 * replay. `sessionSchemaIdentity` MAY be derived from an existing
 * `skillsBinding`, because that is real state this conversation already
 * recorded, not a guess.
 *
 * @param {object|null} rawMeta - TranscriptStore.loadMeta()'s return value
 *   (or any object with the same shape) — never assumed to already carry a
 *   `conversationMetadata` envelope.
 * @returns {object} a current-schema conversationMetadata envelope
 */
export function migrateConversationMetadata(rawMeta) {
  const existing = rawMeta && typeof rawMeta === "object" ? rawMeta.conversationMetadata : null;
  if (existing && existing.schemaVersion === CONVERSATION_METADATA_SCHEMA_VERSION) {
    return existing;
  }
  const legacySkillsBinding = rawMeta && typeof rawMeta === "object" ? rawMeta.skillsBinding || null : null;
  return {
    schemaVersion: CONVERSATION_METADATA_SCHEMA_VERSION,
    appProfile: null,
    sessionSchemaIdentity: buildSessionSchemaIdentity(legacySkillsBinding),
    permissionPolicy: null,
    sdkSessionRef: null,
    budgetPolicy: { ...DEFAULT_BUDGET_POLICY },
    lifecycle: LIFECYCLE.ACTIVE,
    usageEpoch: 0,
    migrationState: freshMigrationState({ backfilled: true, legacy: true })
  };
}
