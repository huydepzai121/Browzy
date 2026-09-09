// Composer page-context chip: title/hostname/favicon of the tab a message
// would target, plus pin/unpin (spec: "Scope and permission controls" —
// "Opening the extension on an existing page SHALL select that page by
// default... Users SHALL be able to pin another permitted tab or remove
// page context. Each submitted message SHALL retain its exact page-context
// identity.").
//
// Task 5.5 (design.md section 5b) extends the 5.2-level display with the
// full atomic binding contract:
//   - a monotonic `_revision`, bumped every time the displayed target
//     actually changes (new tab, new URL/title/favicon, pin, unpin, clear),
//     so a caller can tell "the chip I'm looking at" from "whatever chrome.
//     tabs says right now" apart;
//   - `captureForSend()`, the atomic Send-time gate: it re-queries the
//     authoritative live tab state (never trusts only the last listener-
//     driven update — a suspended/reawoken service worker or a dropped
//     event could leave `_current` stale) and compares it against what was
//     already displayed. A mismatch means the chip was showing an invisible
//     target; this refreshes the chip and reports `changed:true` so the
//     caller (sidepanel.js's doSend) shows the corrected chip and requires
//     an explicit second Send rather than ever silently dispatching against
//     a target the user did not actually see;
//   - `restricted`, a metadata-only (URL-string) classification of pages
//     the browser will never let content scripts or CDP read (chrome://,
//     chrome-extension://, the extension gallery, etc.) — surfaced so the
//     chip can show that binding exists but reading will be refused, without
//     ever touching the page's own content to find out.
//
// The tracking/pin logic is kept in a small class with an injectable
// `tabsApi` (defaults to chrome.tabs/chrome.windows) so its pin/unpin/
// snapshot/captureForSend behavior is unit-testable without a real browser.

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// Kept in sync BY HAND with extension/background.js's own RESTRICTED_URL_PATTERN
// (deliberately duplicated rather than imported — background.js is a service
// worker module and this file loads in the sidepanel's own module graph;
// each module intentionally has zero import-time dependency on the other's
// file so either can be read/tested in isolation). Both only ever inspect
// the URL STRING, never page content, so this classification is safe to run
// merely because the panel is open.
const RESTRICTED_URL_PATTERN =
  /^(chrome|chrome-extension|brave|edge|about|devtools|view-source):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i;

export function isRestrictedUrl(url) {
  return typeof url === "string" && RESTRICTED_URL_PATTERN.test(url);
}

// Display equality: any visible difference in the chip, including cosmetic
// ones (a re-rendered title, a favicon that finished loading). Drives the
// revision counter so the chip re-renders.
function sameTarget(a, b) {
  if (!a || !b) return a === b;
  return a.tabId === b.tabId && a.url === b.url && a.title === b.title && a.favIconUrl === b.favIconUrl;
}

// Binding identity: what design.md 5b actually binds a message to — "browser/
// window/tab ID plus URL/document identity". Title and favicon are display
// metadata, NOT identity: pages rewrite their own title (unread counters,
// clocks, SPA route labels) and load their favicon asynchronously, so
// comparing them at Send time rejects a send against the very same document
// the user is looking at — and on a page whose title keeps changing, every
// retry is rejected too and the message can never be sent.
function sameIdentity(a, b) {
  if (!a || !b) return a === b;
  return a.tabId === b.tabId && a.url === b.url;
}

export class PageContextTracker {
  /**
   * @param {object} [deps]
   * @param {number} [deps.windowId] - the window this panel is attached to.
   * @param {object} [deps.tabsApi] - {query, get, onActivated:{addListener}, onUpdated:{addListener}} — defaults to chrome.tabs.
   */
  constructor({ windowId, tabsApi } = {}) {
    this._windowId = windowId ?? null;
    this._tabs = tabsApi || (typeof chrome !== "undefined" ? chrome.tabs : null);
    this._pinnedTabId = null;
    this._current = null; // {tabId, url, title, hostname, favIconUrl}
    this._revision = 0;
    this._explicitlyRemoved = false;
    this._listeners = new Set();
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    for (const fn of this._listeners) fn(this.snapshot());
  }

  snapshot() {
    if (!this._current) return null;
    return {
      ...this._current,
      pinned: this._pinnedTabId === this._current.tabId,
      restricted: isRestrictedUrl(this._current.url),
      revision: this._revision
    };
  }

  /** True only after an explicit clear(), false again the moment a new
   * target is loaded — distinguishes "the user removed context" (show a
   * re-add affordance) from "context has never been established yet"
   * (e.g. panel still booting). */
  wasExplicitlyRemoved() {
    return this._explicitlyRemoved && !this._current;
  }

  isPinned() {
    return this._pinnedTabId !== null;
  }

  revision() {
    return this._revision;
  }

  async start() {
    if (!this._tabs) return;
    if (this._tabs.onActivated) this._tabs.onActivated.addListener((info) => this._onActivated(info));
    if (this._tabs.onUpdated) this._tabs.onUpdated.addListener((tabId, changeInfo, tab) => this._onUpdated(tabId, changeInfo, tab));
    await this._refreshFromActiveTab();
  }

  async _onActivated(info) {
    if (this._pinnedTabId !== null) return; // pinned: ignore tab-switch until unpinned
    if (this._windowId != null && info.windowId !== this._windowId) return;
    await this._loadTab(info.tabId);
  }

  async _onUpdated(tabId, changeInfo, tab) {
    const targetId = this._pinnedTabId ?? (this._current && this._current.tabId);
    if (tabId !== targetId) return;
    if (changeInfo.url || changeInfo.title || changeInfo.favIconUrl) {
      this._setFromTab(tab);
    }
  }

  async _refreshFromActiveTab() {
    if (this._pinnedTabId !== null) {
      await this._loadTab(this._pinnedTabId);
      return;
    }
    try {
      const query = this._windowId != null ? { active: true, windowId: this._windowId } : { active: true, currentWindow: true };
      const tabs = await this._tabs.query(query);
      if (tabs && tabs[0]) this._setFromTab(tabs[0]);
      else this._clearCurrent();
    } catch {
      this._clearCurrent();
    }
    this._emit();
  }

  async _loadTab(tabId) {
    try {
      const tab = await this._tabs.get(tabId);
      this._setFromTab(tab);
    } catch {
      // Pinned tab closed/unavailable: surface as no context rather than a
      // stale one.
      if (this._pinnedTabId === tabId) this._pinnedTabId = null;
      this._clearCurrent();
    }
    this._emit();
  }

  /** Transition `_current` to null, bumping revision only when this is an
   * actual change (never double-count repeated already-empty refreshes). */
  _clearCurrent() {
    if (this._current) this._revision++;
    this._current = null;
  }

  _setFromTab(tab) {
    if (!tab) return;
    const next = {
      tabId: tab.id,
      url: tab.url || "",
      title: tab.title || tab.url || "",
      hostname: hostnameOf(tab.url),
      favIconUrl: tab.favIconUrl || null
    };
    if (!sameTarget(this._current, next)) this._revision++;
    this._current = next;
    this._explicitlyRemoved = false;
  }

  pinCurrent() {
    if (this._current) this._pinnedTabId = this._current.tabId;
    this._revision++;
    this._emit();
  }

  unpin() {
    this._pinnedTabId = null;
    this._revision++;
    this._refreshFromActiveTab();
  }

  clear() {
    this._pinnedTabId = null;
    this._current = null;
    this._explicitlyRemoved = true;
    this._revision++;
    this._emit();
  }

  /**
   * The atomic Send-time gate (design.md 5b): "At Send, atomically validate
   * the displayed target and snapshot browser/window/tab ID plus URL/
   * document identity and context revision... If UI and host revisions
   * disagree, refresh the chip before dispatch instead of submitting
   * against an invisible target."
   *
   * Re-queries the authoritative live tab (never trusts only the
   * listener-driven cache `_current` already holds), compares it against
   * what is currently displayed, and:
   *   - if they agree: returns `{ changed: false, context }` — safe to bind
   *     `context` to the outgoing message/run exactly as displayed.
   *   - if they disagree (a dropped event, a suspended service worker that
   *     missed a tab switch/close, or a stale pin): refreshes `_current`/
   *     emits the corrected chip and returns `{ changed: true, context }`
   *     WITHOUT the caller having sent anything yet — the caller must show
   *     the corrected chip and require an explicit second Send rather than
   *     silently dispatching the just-discovered new target.
   *
   * @returns {Promise<{changed: boolean, context: object|null}>}
   */
  async captureForSend() {
    const before = this.snapshot();
    if (this._pinnedTabId !== null) {
      await this._loadTab(this._pinnedTabId);
    } else {
      await this._refreshFromActiveTab();
    }
    const after = this.snapshot();
    // Only a real retarget (different tab, different URL, or the target
    // disappearing) blocks the send; a refreshed title/favicon on the same
    // document does not.
    const changed = !sameIdentity(before, after);
    return { changed, context: after };
  }
}
