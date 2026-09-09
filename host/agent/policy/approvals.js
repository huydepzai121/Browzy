// Approval tokens: bound to exact action/target/run, expiring on stop or
// scope change, never reusable by webpage content.
//
// design.md decision 5: "Approval tokens bind exact action/target/run,
// expire on stop or scope change, and are never reusable by webpage
// content." A token issued for one permission decision must not silently
// authorize a different tool, a different tab, or a later run — the whole
// point is that a model cannot stretch one human "yes" further than the
// human actually agreed to, and that nothing on a page can hand itself an
// approval it was never given.

import crypto from "node:crypto";

export function newApprovalToken() {
  return `appr_${crypto.randomBytes(16).toString("hex")}`;
}

export class ApprovalRegistry {
  constructor(opts = {}) {
    this.defaultTtlMs = opts.defaultTtlMs ?? 5 * 60_000;
    this._tokens = new Map(); // token -> { runId, action, target, expiresAt, used }
  }

  /**
   * @param {object} spec
   * @param {string} spec.runId
   * @param {string} spec.action - exact tool/action name this token authorizes
   * @param {object} spec.target - exact target (e.g. { tabId, ref }) this token authorizes
   * @param {number} [spec.ttlMs]
   */
  issue({ runId, action, target, ttlMs }) {
    if (!runId || !action) throw new Error("issue requires runId and action");
    this._sweepExpired();
    const token = newApprovalToken();
    this._tokens.set(token, {
      runId,
      action,
      target: target ?? null,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
      used: false
    });
    return token;
  }

  /**
   * Verify (and, on success, consume) a token against the exact action/target
   * of the call attempting to use it. A token is single-use: consuming it
   * once for its bound action prevents replay against a second dispatch even
   * within its TTL.
   */
  consume(token, { runId, action, target }) {
    const entry = this._tokens.get(token);
    if (!entry) return { ok: false, reason: "unknown_token" };
    if (entry.used) return { ok: false, reason: "already_used" };
    if (Date.now() > entry.expiresAt) {
      this._tokens.delete(token);
      return { ok: false, reason: "expired" };
    }
    if (entry.runId !== runId) return { ok: false, reason: "run_mismatch" };
    if (entry.action !== action) return { ok: false, reason: "action_mismatch" };
    if (!targetsMatch(entry.target, target)) return { ok: false, reason: "target_mismatch" };
    // Mark used rather than delete: a replay attempt against the SAME
    // token must be told "already_used" (a meaningfully different signal
    // from "unknown_token", e.g. for diagnosing a webpage trying to reuse a
    // captured token) instead of looking like it never existed.
    entry.used = true;
    return { ok: true };
  }

  /** Stop invalidates every outstanding approval for that run. */
  invalidateForRun(runId) {
    for (const [token, entry] of this._tokens) {
      if (entry.runId === runId) this._tokens.delete(token);
    }
  }

  /** Scope change (e.g. browser switch, tab scope narrowed) invalidates everything outstanding. */
  invalidateAll() {
    this._tokens.clear();
  }

  // Opportunistic cleanup so a long-lived companion does not accumulate
  // used/expired tokens forever; called on every issue() rather than on a
  // timer, since a companion with no activity needs no cleanup.
  _sweepExpired() {
    const now = Date.now();
    for (const [token, entry] of this._tokens) {
      if (entry.used || now > entry.expiresAt) this._tokens.delete(token);
    }
  }

  isValid(token) {
    const entry = this._tokens.get(token);
    return !!entry && !entry.used && Date.now() <= entry.expiresAt;
  }
}

function targetsMatch(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (typeof a !== "object" || typeof b !== "object" || !b) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => a[k] === b[k]);
}
