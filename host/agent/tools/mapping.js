// SDK-facing operation-name mapping and borrowed-tab scope (design.md task
// group 6, decisions 5b and 6).
//
// Two independent jobs, both scoped to the SDK path only:
//
// 1. Friendly-name mapping (decision 6): "Map SDK-facing friendly aliases
//    back to legacy names without changing executor schemas... Legacy names
//    containing mcp remain internal compatibility aliases only." The three
//    `_mcp`-suffixed legacy names (tabs_context_mcp, tabs_create_mcp,
//    tabs_close_mcp) get real, tested, bidirectional friendly aliases here.
//
//    IMPORTANT, and recorded rather than silently worked around: the actual
//    SDK tool() REGISTRATION in host/agent/tools/adapter.js still registers
//    under the legacy name, not the friendly one. host/test/
//    agent-tool-adapter.test.mjs (an existing, passing, out-of-scope-to-edit
//    suite from task group 3) asserts byte-identical registration — the set
//    of registered tool names equals TOOLS.map(t => t.name) exactly, with no
//    substitutions and no extra/duplicate entries. Renaming the registration
//    would break that suite, which this change's acceptance criteria require
//    to keep passing. So this module's mapping is real, bidirectional, and
//    exercised by its own tests (test/registry-sdk-mapping.test.mjs) as the
//    resolution layer any future SDK-facing caller (or a later, deliberate
//    registration-name change) would use — it is wired into
//    host/agent/tools/adapter.js today for description text (see
//    sdkFacingDescription below), not for the registered identifier.
//
// 2. Borrowed-tab scope (decision 5b): "Adapt the SDK path to a validated
//    per-run borrowed-tab scope... Bound article reading gets read-only
//    access to that tab; mutations need authorization from the actual user
//    task... Shared tool handlers must distinguish borrowed tabs from
//    agent-created tabs so cleanup never closes or regroups borrowed tabs."
//    This lives here — not in host/agent/session/run.js or
//    host/agent/broker/browser-lease.js, both outside this task's file
//    ownership — as WeakMaps keyed by the Run instance, so nothing about
//    Run's shape or constructor needs to change: any object with a stable
//    identity works as a WeakMap key. Legacy MCP clients never construct a
//    Run at all (host/mcp-server.js and host/codemode/* call
//    host/tool-runtime.js directly, with no runId), so every function below
//    is structurally inert for them.

import { TOOLS } from "../../tool-definitions.js";

// --- 1. Friendly name mapping (legacy names containing "mcp" only) --------

export const FRIENDLY_TO_LEGACY = Object.freeze({
  list_tabs: "tabs_context_mcp",
  create_tab: "tabs_create_mcp",
  close_tabs: "tabs_close_mcp"
});

export const LEGACY_TO_FRIENDLY = Object.freeze(
  Object.fromEntries(Object.entries(FRIENDLY_TO_LEGACY).map(([friendly, legacy]) => [legacy, friendly]))
);

/** The SDK-facing friendly name for a legacy executor tool name, or the name
 * unchanged if it has no friendly alias (every tool except the three above). */
export function sdkFacingName(legacyName) {
  return LEGACY_TO_FRIENDLY[legacyName] ?? legacyName;
}

/** Resolve either a friendly alias or an already-legacy name back to the
 * legacy executor name host/tool-runtime.js and extension/background.js
 * expect. Unknown input passes through unchanged (the caller's existing
 * unknown-tool handling — host/agent/policy/authorization.js's
 * `unknown_tool` rejection — is what actually rejects it). */
export function legacyNameFor(nameOrAlias) {
  return FRIENDLY_TO_LEGACY[nameOrAlias] ?? nameOrAlias;
}

// --- SDK-facing description revision (current-page defaults, decision 5b) -
//
// "Revise the SDK tool descriptions that currently mandate creating a new
// tab so they agree with current-page defaults." The shared
// host/tool-definitions.js registry — and its committed baseline snapshot,
// test/fixtures/registry-baseline.json — stays byte-for-byte unchanged:
// legacy MCP clients keep seeing the original wording verbatim. This
// function derives a separate, SDK-only description string; it never
// mutates a TOOLS entry.

const CONTEXT_FIRST_WORDING =
  /CRITICAL: You must get the context at least once before using other browser automation tools so you know what tabs exist\. Each new conversation should create its own new tab \(using tabs_create_mcp\) rather than reusing existing tabs, unless the user explicitly asks to use an existing tab\./;
const CONTEXT_FIRST_REPLACEMENT =
  "By default, operate on the page already provided as this run's context — do not create a new tab just to get started. Call this first only to discover what else is in scope, and create a new tab only when the task genuinely needs a separate page.";

const CREATE_TAB_CRITICAL_WORDING =
  /CRITICAL: You must get the context using tabs_context_mcp at least once before using other browser automation tools so you know what tabs exist\./;
const CREATE_TAB_CRITICAL_REPLACEMENT =
  "Use this only when the task genuinely needs a new page — the page already provided as this run's context is the default target for reading and acting.";

const CURRENT_GROUP_WORDING = /Must be a tab in the current group\.?/g;
const CURRENT_GROUP_REPLACEMENT =
  "Must be a tab within this run's scope — usually the page already provided as context, or a tab this run created.";

// Task 5.6 (design.md 5b): "For a request referring to the current article,
// provide the bound context as structured trusted metadata and call live
// page extraction... before analysis... Context metadata alone SHALL not
// count as reading." get_page_text/read_page are the two live-extraction
// tools that claim; their SDK-facing description gets this note appended so
// the model sees, in the tool's own contract, that a stale/restricted/
// truncated result is not a completed reading.
const LIVE_EXTRACTION_NOTE =
  " This performs a live read of the current DOM, including content beyond the visible viewport — not a cached or " +
  "summarized copy. The result reports the source URL/title, a capture timestamp, and whether the text was " +
  "truncated. A stale-context or restricted-page result means the page was NOT actually read: report that " +
  "limitation plainly instead of guessing, fabricating, or answering from title/URL metadata alone.";

// Task 10.3 (design section 9c): listing-page tool-description steering.
// Each note below is appended to the named tool's SDK-facing description so
// the model is steered toward the right read-only tool for a listing/index
// page (many similar repeated links, no single dominant text block) instead
// of assuming the page has no more content or resorting to page scripting.
// Text-only change — the legacy host/tool-definitions.js registry and its
// committed baseline snapshot (test/fixtures/registry-baseline.json) stay
// byte-for-byte unchanged.
const LISTING_STEERING_NOTE_GET_PAGE_TEXT =
  " If the result's 'Complete' status is 'partial', or the captured container holds only boilerplate/footer/text " +
  "while the page appears to have many similar repeated links or items (a listing, search, or index page), do NOT " +
  "assume the page has no more content. Use read_page (filter 'interactive' to enumerate every link/anchor with " +
  "its text) or find (with a query like 'tender notice links') to read the listed items read-only instead.";

const LISTING_STEERING_NOTE_READ_PAGE_FIND =
  " This is the read-only way to enumerate links and list items on a listing, search, or index page — " +
  "use it (or 'find' for a narrower query) when get_page_text returns only boilerplate or a partial result " +
  "from a small fallback container. Prefer it over javascript_tool for reading content that is already " +
  "available read-only.";

const JAVASCRIPT_TOOL_STEERING_NOTE =
  " Reserved for cases genuinely requiring page scripting — DOM state not exposable through read_page or find, " +
  "or an interaction those tools cannot express. Not a first resort for reading or enumerating content already " +
  "available read-only. On a borrowed tab (the page provided as this run's context), javascript_tool calls are " +
  "rejected by the borrowed-tab scope guard regardless of whether the script mutates: use read_page or find for " +
  "reading instead.";

const LIVE_EXTRACTION_TOOLS = new Set(["get_page_text", "read_page"]);

// Tools that get the listing-page steering note (read_page and find both
// cover enumeration of links/items, per design 9b/9c).
const LISTING_STEERING_READ_TOOLS = new Set(["read_page", "find"]);

/** SDK-only description text for one legacy TOOLS entry. Pure string
 * transform; the source TOOLS array is never touched. */
export function sdkFacingDescription(legacyTool) {
  let text = legacyTool.description;
  text = text.replace(CONTEXT_FIRST_WORDING, CONTEXT_FIRST_REPLACEMENT);
  text = text.replace(CREATE_TAB_CRITICAL_WORDING, CREATE_TAB_CRITICAL_REPLACEMENT);
  text = text.replace(CURRENT_GROUP_WORDING, CURRENT_GROUP_REPLACEMENT);
  if (LIVE_EXTRACTION_TOOLS.has(legacyTool.name)) text += LIVE_EXTRACTION_NOTE;
  // Task 10.3: listing-page steering notes (design section 9c).
  if (legacyTool.name === "get_page_text") text += LISTING_STEERING_NOTE_GET_PAGE_TEXT;
  if (LISTING_STEERING_READ_TOOLS.has(legacyTool.name)) text += LISTING_STEERING_NOTE_READ_PAGE_FIND;
  if (legacyTool.name === "javascript_tool") text += JAVASCRIPT_TOOL_STEERING_NOTE;
  return text;
}

/** Every registry tool, annotated with its SDK-facing friendly name and
 * current-page-default description, without mutating host/tool-definitions.js.
 * `legacyName` is always the real executor contract name to dispatch with;
 * `sdkName` is the friendly alias where one exists (identity otherwise). */
export function sdkFacingToolDefs() {
  return TOOLS.map((t) => ({
    ...t,
    legacyName: t.name,
    sdkName: sdkFacingName(t.name),
    description: sdkFacingDescription(t)
  }));
}

// --- 2. Borrowed-tab scope (design.md decision 5b) -------------------------

const agentCreatedTabsByRun = new WeakMap(); // Run -> Set<tabId>
const mutationAuthorizationsByRun = new WeakMap(); // Run -> Set<tabId>

function tabSetFor(map, run) {
  let set = map.get(run);
  if (!set) {
    set = new Set();
    map.set(run, set);
  }
  return set;
}

/** Record that `run` itself created `tabId` (e.g. a successful create_tab /
 * tabs_create_mcp dispatch). Idempotent. */
export function recordAgentCreatedTab(run, tabId) {
  if (typeof tabId !== "number") return;
  tabSetFor(agentCreatedTabsByRun, run).add(tabId);
}

export function isAgentCreatedTab(run, tabId) {
  return agentCreatedTabsByRun.get(run)?.has(tabId) ?? false;
}

export function isTabInRunScope(run, tabId) {
  const scope = run?.tabScope;
  if (scope === "any") return true;
  return Array.isArray(scope) && scope.includes(tabId);
}

/**
 * A tab is "borrowed" for a run when it is inside that run's tab scope but
 * was not created by the run itself — the pre-existing tab bound to the run
 * at Send (design.md 5b's "bound article tab"). A tab outside the run's
 * scope entirely is neither borrowed nor agent-created here — it is simply
 * unauthorized, and host/agent/policy/authorization.js's existing tab-scope
 * check (unchanged, outside this task's ownership) already rejects it before
 * this function is ever asked.
 */
export function isBorrowedTab(run, tabId) {
  return isTabInRunScope(run, tabId) && !isAgentCreatedTab(run, tabId);
}

/**
 * Explicit, real authorization hook for lifting the read-only default on one
 * borrowed tab for one run. Called automatically (task 9.3 / design 9d) once
 * a run's own instruction legitimately calls for interacting with its bound
 * tab — for the automatic action set only: `computer`'s non-submit-classified
 * actions and `form_input`. `javascript_tool` is deliberately EXCLUDED
 * (task 10.4 / design 9d): the flag is per-tab with no notion of which tool
 * asked, so granting it for typing would silently also authorize a later
 * navigating script. A `javascript_tool` call against a borrowed tab keeps
 * requiring its own authorization, which nothing in this change grants
 * automatically.
 */
export function authorizeBorrowedTabMutation(run, tabId) {
  if (typeof tabId !== "number") return;
  tabSetFor(mutationAuthorizationsByRun, run).add(tabId);
}

export function isBorrowedTabMutationAuthorized(run, tabId) {
  return mutationAuthorizationsByRun.get(run)?.has(tabId) ?? false;
}

// Task 10.4 (design section 9d): javascript_tool has its OWN separate
// per-run, per-tab authorization flag — never consulted by the shared
// `isBorrowedTabMutationAuthorized()` and never set by
// `authorizeBorrowedTabMutation()`. This means authorizing a tab for
// typing/filling does NOT also permit a subsequent javascript_tool call
// against that tab. Nothing in this change grants javascript_tool
// authorization automatically; a future change could add one deliberately,
// but none is proposed here. The residual limitation (a legitimately
// read-only script against a borrowed tab still fails) is accepted,
// mitigated by tool-description steering (10.3) and read-only enumeration
// tools (read_page/find).
const jsToolMutationAuthorizationsByRun = new WeakMap(); // Run -> Set<tabId>

export function authorizeJavaScriptToolBorrowedTab(run, tabId) {
  if (typeof tabId !== "number") return;
  tabSetFor(jsToolMutationAuthorizationsByRun, run).add(tabId);
}

export function isJavaScriptToolBorrowedTabAuthorized(run, tabId) {
  return jsToolMutationAuthorizationsByRun.get(run)?.has(tabId) ?? false;
}

// --- 9.1: Send/submit-class classifier (design.md section 8) --------------
//
// A narrowing predicate that sits in front of only the tools that can produce
// both an always-automatic call and a send/submit-class call under the same
// tool name. Per design.md 8 / 9:
//   - A `computer` call whose target is a submit-type control, or whose key
//     event or description matches a localized submit/send/pay/confirm word
//   - A `javascript_tool` script that calls `.submit()` or dispatches a
//     submit event on a form (best-effort static check)
// Reuses (not duplicates) isMutatingCall() — stays independent of the
//_RADICAL existing classification (which never changes). A non-send call
// on `computer`/`javascript_tool` still executes with no prompt.

const SUBMIT_KEYWORDS_VERBOSE_LOWER = ["submit", "send", "pay", "confirm", "checkout", "place order"];
const SUBMIT_KEYWORDS_VI_LOWER = ["gửi", "xác nhận", "thanh toán", "đặt hàng", "gửi đi"];

function submitKeywordMatchLower(text) {
  if (!text || typeof text !== "string") return false;
  for (const kw of SUBMIT_KEYWORDS_VERBOSE_LOWER) {
    if (text.includes(kw)) return true;
  }
  return false;
}

/** Resolve the "action" descriptor from a `computer` call. The caller has the
 *  tool's args; this function inspects those args plus any classifier-level
 *  element metadata hint the caller may pass via `targetHint`. The hint's
 *  shape mirrors what `find` returns: { accessibleName?, role?, tagName?, attributes? }
 *  and is freely available at call time when the model provided a `ref` that
 *  was resolved by the extension's element registry. When no hint is
 *  available this still inspects the args' own descriptive fields. */
function isComputerSubmitCall(args = {}, targetHint) {
  if (!args) return false;
  const action = String(args.action || "").toLowerCase();

  // Screenshots, zooms, scroll/wait are explicitly excluded by design ("Every
  // other click, hover, drag, type, key, scroll, wait, screenshot, zoom, and
  // non-submitting script is not gated").
  // We gate: `click` on a submit-type control, or `key` Enter/Space on a
  // submit-type control the hint identifies.
  if (action !== "click" && action !== "key") return false;

  const textFromHint = (() => {
    if (targetHint) {
      const parts = [targetHint.accessibleName, targetHint.role, targetHint.tagName, targetHint.attributes?.type, targetHint.attributes?.value];
      return parts.filter((p) => p != null).join(" ").toLowerCase?.();
    }
    return null;
  })();
  if (textFromHint && submitKeywordMatchLower(textFromHint)) return true;
  for (const kw of SUBMIT_KEYWORDS_VI_LOWER) {
    if (textFromHint && textFromHint.includes(kw)) return true;
  }

  // When the args themselves carry a `description` field (rare/optional) match
  // that too, so a model calling the tool with a self-described submit button
  // text gets gated without requiring the hint.
  if (submitKeywordMatchLower(String(args.description || "").toLowerCase())) return true;
  for (const kw of SUBMIT_KEYWORDS_VI_LOWER) {
    if (String(args.description || "").toLowerCase().includes(kw)) return true;
  }

  // When the hint says the target is a `<button type=submit>` or
  // `<input type=submit>`, gate it unconditionally regardless of accessible
  // name.
  if (targetHint) {
    const tagLower = String(targetHint.tagName || "").toLowerCase();
    const typeAttr = String(targetHint.attributes?.type || "").toLowerCase();
    if (tagLower === "input" && typeAttr === "submit") return true;
    if (tagLower === "button" && (typeAttr === "submit" || typeAttr == null)) return true;
  }
  return false;
}

function isJavascriptToolSubmitScript(args = {}) {
  if (!args || !args.script) return false;
  const script = String(args.script);
  // Design 8: best-effort check for `.submit()` or `submit` event dispatch.
  // Per the design's own residual-risk note, a script that submits a form
  // through indirection this check cannot see is a disclosed residual risk —
  // it still passes through the unconditional handler-side checks below.
  if (/\.submit\s*\(\s*\)/.test(script)) return true;
  if (/dispatchEvent\s*\(\s*new\s+\w*Event\s*\(\s*['"]submit['"]/.test(script)) return true;
  if (/new\s+\w*SubmitEvent\s*\(\s*\)/.test(script) && /dispatchEvent/.test(script)) return true;
  // A `<form>.requestSubmit()` call (WHATWG standard) is also a submission.
  if (/requestSubmit\s*\(\s*\)/.test(script)) return true;
  return false;
}

/**
 * @param {string} legacyToolName
 * @param {object} [args]
 * @param {object} [targetHint] - optional classifier-level element metadata,
 *   freely available at call time
 * @returns {boolean} true if this is a send/submit-class call that needs a
 *   user decision before execution (design.md section 8). Reuses, rather than
 *   duplicates, isMutatingCall()'s existing table — a non-submit
 *   `computer`/`javascript_tool` call returns false here and still executes
 *   with no prompt.
 */
export function isSendClassCall(legacyToolName, args = {}, targetHint) {
  if (legacyToolName === "computer") return isComputerSubmitCall(args, targetHint);
  if (legacyToolName === "javascript_tool") return isJavascriptToolSubmitScript(args);
  return false;
}

// --- Mutating vs. read-only classification, by legacy tool name -----------
//
// A closed, exhaustive classification of all 26 registry tools (`computer`
// is classified per-action instead of as a whole, since a single call can be
// a screenshot or a click). A registry-baseline-style test asserts this
// classification's two sets plus "computer" account for every TOOLS entry,
// so a future registry addition cannot silently fall through the default.

const READ_ONLY_LEGACY_TOOLS = new Set([
  "tabs_context_mcp",
  "get_page_text",
  "read_page",
  "find",
  "read_console_messages",
  "read_network_requests",
  "debug",
  "debug_timings",
  "get_config",
  "shortcuts_list",
  "retranscribe_recording",
  "switch_browser",
  "update_plan"
]);

const MUTATING_LEGACY_TOOLS = new Set([
  "tabs_create_mcp",
  "tabs_close_mcp",
  "navigate",
  "form_input",
  "javascript_tool",
  "upload_image",
  "file_upload",
  "gif_creator",
  "shortcuts_execute",
  "resize_window",
  "set_tab_focus",
  "set_config"
]);

// `screenshot`/`zoom` capture pixels without touching the page; `scroll`/
// `scroll_to`/`wait` are needed for design.md 5b's "content beyond the
// viewport" reading use case and do not mutate page state. Every other
// `computer` action (click/type/key/drag/hover) is a real interaction with
// the page and is conservatively treated as mutating.
const COMPUTER_READ_ONLY_ACTIONS = new Set(["screenshot", "zoom", "scroll", "scroll_to", "wait"]);

/**
 * @param {string} legacyToolName
 * @param {object} [args]
 * @returns {boolean} true if this call would mutate browser/page state.
 */
export function isMutatingCall(legacyToolName, args = {}) {
  if (legacyToolName === "computer") {
    return !COMPUTER_READ_ONLY_ACTIONS.has(args?.action);
  }
  if (READ_ONLY_LEGACY_TOOLS.has(legacyToolName)) return false;
  if (MUTATING_LEGACY_TOOLS.has(legacyToolName)) return true;
  // Fail safe: an unrecognized tool defaults to mutating rather than ever
  // silently being treated as safe against a borrowed tab.
  return true;
}

export function _mutationClassificationCoverage() {
  return { readOnly: READ_ONLY_LEGACY_TOOLS, mutating: MUTATING_LEGACY_TOOLS };
}

// Legacy tool names whose args carry a `tabId`-shaped target to check against
// borrowed-tab scope. Mirrors host/agent/policy/authorization.js's
// TAB_ARG_KEYS (which this module intentionally does not import, to keep
// that file's ownership untouched) — kept here as its own small, explicit,
// tested table rather than re-deriving it from the JSON schema.
const TAB_TARGET_ARG_KEYS = {
  navigate: ["tabId"],
  computer: ["tabId"],
  find: ["tabId"],
  form_input: ["tabId"],
  get_page_text: ["tabId"],
  javascript_tool: ["tabId"],
  read_console_messages: ["tabId"],
  read_network_requests: ["tabId"],
  read_page: ["tabId"],
  resize_window: ["tabId"],
  set_tab_focus: ["tabId"],
  upload_image: ["tabId"],
  file_upload: ["tabId"],
  shortcuts_list: ["tabId"],
  shortcuts_execute: ["tabId"],
  gif_creator: ["tabId"],
  tabs_close_mcp: ["tabId", "tabIds"]
};

export class BorrowedTabMutationError extends Error {
  constructor(tabId) {
    super(
      `Tab ${tabId} is a borrowed page tab bound to this run's context (read-only by default). ` +
        `Mutating it requires explicit authorization from the actual user task, which this call does not have.`
    );
    this.name = "BorrowedTabMutationError";
    this.tabId = tabId;
  }
}

/**
 * The borrowed-tab scope gate itself (design.md 5b), run in addition to —
 * never instead of — host/agent/policy/authorization.js's existing
 * unconditional tab-scope check. For every tabId the call targets: if it is
 * a mutating call and the target tab is borrowed (in this run's scope, not
 * created by this run) and not explicitly authorized for mutation, throw.
 * A read-only call, or a call against an agent-created tab, or an
 * already-authorized borrowed tab, passes silently.
 *
 * Task 10.4 (design section 9d): when the tool is `javascript_tool`, the
 * shared per-tab mutation flag is NEVER consulted. `javascript_tool` checks
 * its OWN separate, never-automatically-granted authorization state. This
 * means authorizing a tab for typing/filling (via
 * `authorizeBorrowedTabMutation()`) does NOT also permit a subsequent
 * `javascript_tool` call against that tab — including a navigation
 * (`window.location.href = ...`), which the live evidence proves must stay
 * blocked. There is no automatic grant for `javascript_tool` in this change.
 *
 * @throws {BorrowedTabMutationError}
 */
export function enforceBorrowedTabScope({ run, legacyToolName, args }) {
  const argKeys = TAB_TARGET_ARG_KEYS[legacyToolName];
  if (!argKeys) return;
  const mutating = isMutatingCall(legacyToolName, args);
  if (!mutating) return;
  for (const key of argKeys) {
    const value = args?.[key];
    if (value === undefined || value === null) continue;
    const tabIds = Array.isArray(value) ? value : [value];
    for (const tabId of tabIds) {
      if (typeof tabId !== "number") continue;
      if (!isBorrowedTab(run, tabId)) continue;
      // Task 10.4: javascript_tool has its own separate authorization flag,
      // never set by authorizeBorrowedTabMutation(). This is the load-bearing
      // fix for the latent bug 9.3's original wording would have introduced.
      if (legacyToolName === "javascript_tool") {
        if (!isJavaScriptToolBorrowedTabAuthorized(run, tabId)) {
          throw new BorrowedTabMutationError(tabId);
        }
      } else {
        if (!isBorrowedTabMutationAuthorized(run, tabId)) {
          throw new BorrowedTabMutationError(tabId);
        }
      }
    }
  }
}

/** Best-effort extraction of a newly created tabId from tabs_create_mcp's
 * shipped result text ("Created new tab. Tab ID: 123\n\n..." —
 * extension/background.js's tabs_create_mcp handler). Used so a successful
 * SDK-path create_tab call marks its own new tab agent-created without
 * needing any new wire field. Returns null if the shape doesn't match. */
export function extractCreatedTabId(result) {
  const text = Array.isArray(result?.content)
    ? result.content.find((b) => b.type === "text")?.text
    : null;
  if (typeof text !== "string") return null;
  const m = text.match(/Tab ID:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}
