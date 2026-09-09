// `canUseTool` callback implementation for send/submit-class gating
// (design.md section 8 / task 9.2).
//
// Per the SDK's own docstring (sdk.d.ts:203-208): "Return `null` ONLY after
// the consumer has already sent the control_response out-of-band... Fail-
// closed: an accidental null means no response is sent and the tool stays
// blocked indefinitely." This module never returns null: every code path
// resolves either `{behavior:'allow', ...}` or `{behavior:'deny', ...}`.
//
// Behavior:
//   0. For a `WebFetch` call, classify its URL via
//      `./webfetch-url-guard.js`'s `classifyWebFetchUrl()` and resolve
//      `{behavior:'deny', message}` or `{behavior:'allow'}` immediately —
//      this is a local, already-known answer (not a user decision), so it
//      never issues an approval token and never emits `approval_request`.
//   1. For a NON-send-class call (per `isSendClassCall()`), immediately
//      resolve `{behavior:'allow'}` so the SDK proceeds to the tool handler
//      with no prompt. This is the contract task 9.1 + 9.2 establish.
//   2. For a send-class call:
//      a. Issue an `ApprovalRegistry` token via `run.issueApproval(action,
//         target)` — bound to run/action/target exactly as the registry
//         already does.
//      b. Emit a sequenced `approval_request` stream event so the panel can
//         render the card (this event survives a reconnect via TranscriptStore).
//      c. Suspend resolution pending the panel's matching `approval_decision`
//         or the bound 5-minute timeout (the registry's `defaultTtlMs`).
//   3. On `approve`: verify the token via `run.consumeApproval()` and resolve
//      `{behavior:'allow'}`.
//   4. On `deny`: resolve `{behavior:'deny', message}` with a user-legible
//      reason.
//   5. On timeout: resolve `{behavior:'deny', message}` with a distinguishable
//      timeout reason (NEVER null, NEVER an indefinite hang).
//   6. On Stop (the run is stopped, which calls
//      `approvals.invalidateForRun()` synchronously) or scope change
//      (`approvals.invalidateAll()`) or credential revocation, the token
//      becomes `unknown_token`; the next consume attempt returns
//      `unknown_token` so we resolve deny with a distinguishable reason.
//
// The callback is created per-run (binding to one Run + ApprovalRegistry +
// one event emitter + one "decision resolver" hooked to the wire).

import { isSendClassCall } from "../tools/mapping.js";
import { classifyWebFetchUrl, readWebFetchUrl } from "./webfetch-url-guard.js";

/**
 * Build a `canUseTool` callback bound to a specific run.
 *
 * @param {object} deps
 * @param {import("../session/run.js").Run} deps.run
 * @param {import("../policy/approvals.js").ApprovalRegistry} deps.approvals
 * @param {object} deps.requestIdTracker - holds pending approval promises keyed
 *   by requestId, so the wire-side `approval_decision` handler can resolve one.
 *   Must implement `set(requestId, resolverFn, token)`,
 *   `take(requestId)` returning `{ resolverFn, token } | undefined`,
 *   and `clearRun(runId)` to reject everything in-flight for a stop/scope change.
 * @param {object} [deps.now] - injectable Date.now for tests
 * @returns {Function} a `canUseTool(toolContext) => Promise<PermissionResult>`
 *   suitable for assignment to `Options.canUseTool`
 */
export function createCanUseTool({ run, approvals, requestIdTracker, now = Date.now }) {
  if (!run) throw new Error("createCanUseTool requires a run");
  if (!approvals) throw new Error("createCanUseTool requires approvals");
  if (!requestIdTracker) throw new Error("createCanUseTool requires requestIdTracker");

  return async function canUseTool(toolContext) {
    // Per sdk.d.ts:209-262, the second parameter carries `toolName`, `input`,
    // and a `requestId`/`toolUseID`. The exact field name carrying the
    // SDK-side request id is `tool_use_id` or `requestId` depending on the
    // build; defensively check both. When neither is present we mint a
    // local requestId so the wire `approval_request`/`approval_decision`
    // correlation still has something to echo.
    const sdkRequestId = toolContext?.toolUseID || toolContext?.tool_use_id || toolContext?.requestId || `local_${now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Resolve the legacy tool name (the SDK-facing server registers tools
    // under their legacy names: "computer", "javascript_tool", etc.) — the
    // tool's `name` here is the SDK-facing registered name.
    const toolName = toolContext?.toolName || "";
    // Build args/input snapshot. The SDK passes the call's input here.
    const args = toolContext?.input ?? {};

    // === 0. WebFetch: local URL guard, decided synchronously, no panel ===
    // WebFetch is available (query-options.js's `tools`) but deliberately
    // never auto-approved (absent from `allowedTools`), so every call lands
    // here. Unlike the send-class approval flow below, this is NOT something
    // a user needs to weigh in on — the URL's host is either an ordinary
    // public address or it plainly is not, and that answer is already known
    // before the fetch. So this branch decides LOCALLY and returns
    // immediately: it never issues an approval token, never emits an
    // `approval_request` event, and never awaits a panel decision. See
    // ./webfetch-url-guard.js for exactly what this does and does not
    // protect against (name-based, pre-redirect — not a boundary against a
    // determined attacker who controls DNS or a redirect target).
    if (toolName === "WebFetch") {
      // Field-name extraction lives in the guard module so this branch and
      // the PreToolUse hook read the call the same way — two readers that
      // disagreed would mean one of them silently allowing what the other
      // denies.
      const verdict = classifyWebFetchUrl(readWebFetchUrl(args));
      if (!verdict.allowed) {
        return { behavior: "deny", message: verdict.reason };
      }
      return { behavior: "allow" };
    }

    // === 1. Classify ===  (per design 8: a non-send `computer`/`javascript_tool`
    // call is auto-allowed with no prompt)
    if (!isSendClassCall(toolName, args)) {
      return { behavior: "allow" };
    }

    // === 2. Build the action/target descriptor and mint an approval token ===
    const action = buildActionDescriptor(toolName, args);
    const target = buildTargetDescriptor(toolName, args);

    let token;
    try {
      token = run.issueApproval(action, target);
    } catch (err) {
      // The registry throws if runId or action are falsy — but a send-class
      // call always has both. Fail closed anyway.
      return { behavior: "deny", message: `internal error issuing approval token: ${err && err.message}` };
    }

    // === 3. Emit the approval_request stream event ===
    // The wire envelope carries the requestId (NOT the token), the action
    // descriptor, and the target. CompanionCore forwards this through its
    // event emitter (TranscriptStore handles persistence + reconnect replay).
    run.emit({
      type: "approval_request",
      requestId: sdkRequestId,
      action,
      target,
      ts: now()
    });

    // === 4. Suspend the SDK call pending a decision, with the registry's
    // TTL as the wait budget ===
    const ttlMs = approvals.defaultTtlMs;
    return await new Promise((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        requestIdTracker.take(sdkRequestId);
        // The token has expired by now (registry sweeps on issue); not used
        // further. Per design: never resolve `null`, never hang.
        resolve({ behavior: "deny", message: `Quá thời gian chờ cấp quyền (${Math.round(ttlMs / 1000)} giây). Hành động gửi/gửi-form chưa được phê duyệt.` });
      }, ttlMs);

      requestIdTracker.set(sdkRequestId, (decision) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (decision && decision.decision === "approve") {
          // Verify the token before letting the call through. This catches
          // stop, scope change, credential revocation, replay, and run
          // mismatch — all of which invalidate the registry entry.
          const verify = run.consumeApproval(token, action, target);
          if (verify.ok) {
            resolve({ behavior: "allow" });
          } else {
            resolve({ behavior: "deny", message: `Phiếu phê duyệt không hợp lệ (${verify.reason}). Hành động không được thực thi.` });
          }
        } else if (decision && decision.decision === "deny") {
          resolve({ behavior: "deny", message: "Người dùng đã từ chối cấp quyền cho hành động này." });
        } else if (decision && decision.reason) {
          // An invalidation (stop/scope change/credential): the denial
          // reason tells the model and the transcript what actually happened.
          resolve({ behavior: "deny", message: decision.reason });
        } else {
          resolve({ behavior: "deny", message: "Quyết định phê duyệt không hợp lệ." });
        }
      }, token);
    });
  };
}

function buildActionDescriptor(toolName, args) {
  if (toolName === "computer") {
    const action = String(args?.action || "");
    if (action === "click") return "computer click (submit-type control)";
    if (action === "key") return "computer key (submit-type control)";
    return `computer ${action} (submit-type control)`;
  }
  if (toolName === "javascript_tool") {
    return "javascript_tool form-submission script";
  }
  return toolName;
}

function buildTargetDescriptor(toolName, args) {
  const tabId = args?.tabId ?? args?.tab_id ?? null;
  if (tabId != null) return { tabId };
  return null;
}

// ---- RequestIdTracker: small per-run holder for pending approval decisions --
//
// The wire-side handler in companion.js receives an `approval_decision`
// envelope and uses this to resolve the matching `canUseTool` promise. Stop
// and scope-change handlers iterate to reject every pending one.

export class RequestIdTracker {
  constructor() {
    // requestId -> { resolver: Function, token: string }
    this._pending = new Map();
  }
  set(requestId, resolver, token) {
    this._pending.set(requestId, { resolver, token });
  }
  take(requestId) {
    const entry = this._pending.get(requestId);
    if (entry) {
      this._pending.delete(requestId);
      return entry;
    }
    return undefined;
  }
  has(requestId) {
    return this._pending.has(requestId);
  }
  /**
   * Reject every pending decision for a run with a specific reason. Used by
   * stop, scope change, and credential revocation handlers.
   * @param {object} opts
   * @param {string} opts.reason - the denial message the SDK call resolves to
   */
  rejectAll({ reason }) {
    const taken = [...this._pending.values()];
    this._pending.clear();
    for (const { resolver } of taken) {
      try {
        resolver({ decision: "deny", reason });
      } catch {
        // a resolver that throws must not break the invalidation loop
      }
    }
    return taken.length;
  }
  size() {
    return this._pending.size;
  }
}
