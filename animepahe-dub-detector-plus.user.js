// ==UserScript==
// @name         animepahe-dub-detector-plus
// @namespace    https://github.com/abdullahkhfb/animepahe-dub-detector-plus
// @version      2.0.0
// @description  Tags dubbed episodes with DUB badges on animepahe. Includes an in-page Advanced Settings panel powered by your script manager (GM storage).
// @license      GPLv3
// @author       abdullahkhfb
// @icon         https://raw.githubusercontent.com/abdullahkhfb/animepahe-dub-detector-pus/main/icon/animepahe-dub-detector.svg
// @match        *://animepahe.pw/*
// @match        *://animepahe.org/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @grant        GM_info
// @run-at       document-idle
// @noframes
// @downloadURL  https://update.greasyfork.org/scripts/585305/animepahe-dub-detector-plus.user.js
// @updateURL    https://update.greasyfork.org/scripts/585305/animepahe-dub-detector-plus.meta.js
// ==/UserScript==

// ─── Constants ───────────────────────────────────────────────────────────────
const PILL_ID = "ape-dub-pill";
const SETTINGS_PANEL_ID = "ape-dub-settings-panel";
const SETTINGS_OVERLAY_ID = "ape-dub-settings-overlay";
const EP_PREFIX = "d2_";
const HOME_PREFIX = "h2_";
const SETTINGS_KEY = "ape_settings_v4";
const CACHE_VERSION = "v1";
const AUDIO_DUB_VALUES = new Set(["eng", "english", "dub", "dubbed"]);
// eslint-disable-next-line no-unused-vars
const SEARCH_EXCLUDE =
  ".ui-autocomplete, .search-results, header, .top-header, form, #search, .autocomplete, .dropdown";
// ─── Settings schema ─────────────────────────────────────────────────────────
const ADVANCED_SETTINGS_SCHEMA = [
  {
    group: "DUB Detector",
    items: [
      {
        key: "cacheTtlHours",
        label: "Cache duration (hours)",
        desc: "How long detected DUB/SUB results stay cached before being re-checked.",
        min: 1,
        max: 168,
        step: 1,
        default: 24,
      },
      {
        key: "dubParallelProbes",
        label: "Binary-search probes",
        desc: "How many points are probed per step when narrowing down which episodes are dubbed. Higher finds the answer in fewer rounds but fires more requests at once.",
        min: 2,
        max: 30,
        step: 1,
        default: 12,
      },
      {
        key: "dubBatchDelay",
        label: "Delay between batches (ms)",
        desc: "Pause inserted between scan batches/rounds so the site isn't hammered.",
        min: 0,
        max: 10000,
        step: 100,
        default: 2000,
      },
      {
        key: "dubHomeBatchSize",
        label: "Homepage scan batch size",
        desc: "How many homepage cards are checked for dubs at the same time.",
        min: 1,
        max: 10,
        step: 1,
        default: 2,
      },
    ],
  },
  {
    group: "Network Throttler",
    items: [
      {
        key: "throttleMinInterval",
        label: "Min interval between requests (ms)",
        desc: "Minimum spacing enforced between outgoing requests to animepahe.",
        min: 0,
        max: 2000,
        step: 10,
        default: 120,
      },
      {
        key: "throttleJitter",
        label: "Jitter (ms)",
        desc: "Random variation added on top of the minimum interval, so requests don't go out at a perfectly robotic cadence.",
        min: 0,
        max: 1000,
        step: 10,
        default: 50,
      },
      {
        key: "throttleMaxConcurrent",
        label: "Max concurrent requests",
        desc: "How many requests may be in flight at the same time.",
        min: 1,
        max: 20,
        step: 1,
        default: 6,
      },
      {
        key: "throttleMaxRetries",
        label: "Max retries on rate limit",
        desc: "How many times a throttled (429/503) request is retried before giving up.",
        min: 0,
        max: 10,
        step: 1,
        default: 4,
      },
      {
        key: "throttleBaseBackoff",
        label: "Base backoff (ms)",
        desc: "Starting wait time before retrying after a rate-limit response. Doubles with each retry.",
        min: 500,
        max: 30000,
        step: 500,
        default: 3000,
      },
    ],
  },
];
const ADVANCED_DEFAULTS = ADVANCED_SETTINGS_SCHEMA.reduce((acc, group) => {
  for (const item of group.items) {
    acc[item.key] = item.default;
  }
  return acc;
}, {});
const DEFAULT_SETTINGS = {
  dubEnabled: true,
  showSubOnlyBadges: true,
  ...ADVANCED_DEFAULTS,
};
// ─── GM-backed storage adapter ───────────────────────────────────────────────
const storage = {
  get(key) {
    try {
      return GM_getValue(key, undefined);
    } catch {
      return undefined;
    }
  },
  set(key, value) {
    try {
      GM_setValue(key, value);
    } catch (err) {
      console.warn("[DUB] storage.set failed", key, err);
    }
  },
  remove(key) {
    try {
      GM_deleteValue(key);
    } catch (err) {
      console.warn("[DUB] storage.remove failed", key, err);
    }
  },
  keysWithPrefix(prefix) {
    try {
      return GM_listValues().filter((k) => k.startsWith(prefix));
    } catch {
      return [];
    }
  },
  getSettings() {
    const raw = this.get(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    try {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  },
  setSettings(patch) {
    const current = this.getSettings();
    const next = { ...current, ...patch };
    this.set(SETTINGS_KEY, JSON.stringify(next));
    return next;
  },
  resetAdvanced() {
    const current = this.getSettings();
    const next = {
      dubEnabled: current.dubEnabled,
      showSubOnlyBadges: current.showSubOnlyBadges,
      ...ADVANCED_DEFAULTS,
    };
    this.set(SETTINGS_KEY, JSON.stringify(next));
    return next;
  },
};
// ─── Cache module ────────────────────────────────────────────────────────────
function parseCacheEntry(raw) {
  if (!raw || typeof raw !== "string") return null;
  const pipe = raw.indexOf("|");
  if (pipe === -1) return null;
  const timestamp = Number(raw.slice(0, pipe));
  if (!Number.isFinite(timestamp)) return null;
  const rest = raw.slice(pipe + 1);
  if (!rest.startsWith(CACHE_VERSION + "|")) return null;
  return { timestamp, valuePart: rest.slice(CACHE_VERSION.length + 1) };
}
function makeCacheEntry(value) {
  return `${Date.now()}|${CACHE_VERSION}|${JSON.stringify(value)}`;
}
function readCache(key, ttlMs) {
  const raw = storage.get(key);
  const entry = parseCacheEntry(raw);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ttlMs) return null;
  try {
    return JSON.parse(entry.valuePart);
  } catch {
    return null;
  }
}
function writeCache(key, value) {
  storage.set(key, makeCacheEntry(value));
}
function epCacheKey(epSession) {
  return `${EP_PREFIX}${epSession}`;
}
function homeCacheKey(animeSession) {
  return `${HOME_PREFIX}${animeSession}`;
}
function gcDubCache(ttlMs) {
  const now = Date.now();
  let removed = 0;
  const allKeys = [
    ...storage.keysWithPrefix(EP_PREFIX),
    ...storage.keysWithPrefix(HOME_PREFIX),
  ];
  for (const key of allKeys) {
    const entry = parseCacheEntry(storage.get(key));
    if (!entry || now - entry.timestamp > ttlMs) {
      storage.remove(key);
      removed++;
    }
  }
  return removed;
}
function clearDubCache() {
  const allKeys = [
    ...storage.keysWithPrefix(EP_PREFIX),
    ...storage.keysWithPrefix(HOME_PREFIX),
  ];
  for (const key of allKeys) storage.remove(key);
  return allKeys.length;
}
class RequestThrottler {
  constructor(opts = {}) {
    this._queue = [];
    this._active = 0;
    this._lastLaunch = 0;
    this._backoffUntil = 0;
    this._draining = false;
    this._minInterval = opts.throttleMinInterval ?? 120;
    this._jitter = opts.throttleJitter ?? 50;
    this._maxConcurrent = opts.throttleMaxConcurrent ?? 6;
    this._maxRetries = opts.throttleMaxRetries ?? 4;
    this._baseBackoff = opts.throttleBaseBackoff ?? 3000;
  }
  updateOptions(opts) {
    if (opts.throttleMinInterval != null)
      this._minInterval = opts.throttleMinInterval;
    if (opts.throttleJitter != null) this._jitter = opts.throttleJitter;
    if (opts.throttleMaxConcurrent != null)
      this._maxConcurrent = opts.throttleMaxConcurrent;
    if (opts.throttleMaxRetries != null)
      this._maxRetries = opts.throttleMaxRetries;
    if (opts.throttleBaseBackoff != null)
      this._baseBackoff = opts.throttleBaseBackoff;
  }
  fetch(url, wantJson = true) {
    return new Promise((resolve, reject) => {
      this._queue.push({ url, wantJson, resolve, reject, retries: 0 });
      if (!this._draining) void this._drain();
    });
  }
  get pendingCount() {
    return this._queue.length + this._active;
  }
  _sleep(ms) {
    return new Promise((r) => setTimeout(r, Math.max(0, ms)));
  }
  async _drain() {
    this._draining = true;
    while (this._queue.length > 0 || this._active > 0) {
      const backoffRemaining = this._backoffUntil - Date.now();
      if (backoffRemaining > 0) {
        await this._sleep(backoffRemaining);
        continue;
      }
      if (this._queue.length > 0 && this._active < this._maxConcurrent) {
        const jitter =
          Math.floor(Math.random() * this._jitter * 2) - this._jitter;
        const gap = this._minInterval + jitter;
        const since = Date.now() - this._lastLaunch;
        if (since < gap) {
          await this._sleep(gap - since);
          continue;
        }
        const task = this._queue.shift();
        this._active++;
        this._lastLaunch = Date.now();
        void this._execute(task);
        continue;
      }
      await this._sleep(20);
    }
    this._draining = false;
  }
  async _execute(task) {
    try {
      const result = await this._attempt(task.url, task.wantJson);
      task.resolve(result);
    } catch (err) {
      const e = err;
      if (e.rateLimited && task.retries < this._maxRetries) {
        const serverHint = e.retryAfterMs ?? 0;
        const expBackoff = this._baseBackoff * Math.pow(2, task.retries);
        const jitter = Math.random() * expBackoff * 0.5;
        const delay = Math.max(serverHint, expBackoff + jitter);
        this._backoffUntil = Date.now() + delay;
        task.retries++;
        this._queue.push(task);
      } else {
        task.reject(e);
      }
    } finally {
      this._active--;
      if (!this._draining && (this._queue.length > 0 || this._active > 0)) {
        void this._drain();
      }
    }
  }
  async _attempt(url, wantJson) {
    const res = await fetch(url, {
      credentials: "include",
      headers: {
        Accept: wantJson ? "application/json" : "text/html,*/*;q=0.9",
        "X-Requested-With": "XMLHttpRequest",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    });
    if (res.status === 429 || res.status === 503 || res.status === 403) {
      let retryAfterMs = 0;
      const ra = res.headers.get("retry-after");
      if (ra) {
        const secs = Number(ra);
        retryAfterMs =
          Number.isFinite(secs) && secs > 0
            ? secs * 1000
            : Date.parse(ra) - Date.now();
        retryAfterMs = Math.max(0, retryAfterMs);
      }
      if (res.status === 503) {
        const body = await res.text().catch(() => "");
        const isCf =
          /cloudflare|checking your browser|just a moment|cf-browser-verification/i.test(
            body,
          );
        if (!isCf) {
          throw new Error("HTTP 503 (server error, not CF)");
        }
        throw Object.assign(new Error("Cloudflare challenge (503)"), {
          rateLimited: true,
          retryAfterMs,
          isCfChallenge: true,
        });
      }
      throw Object.assign(new Error(`HTTP ${res.status}`), {
        rateLimited: true,
        retryAfterMs,
      });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (wantJson) {
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("json")) {
        const text = await res.text();
        const isCf =
          /cloudflare|checking your browser|just a moment|error\s+1015/i.test(
            text,
          );
        if (isCf) {
          throw Object.assign(
            new Error("Cloudflare interception (200 with HTML)"),
            {
              rateLimited: true,
              isCfChallenge: true,
            },
          );
        }
        throw new Error(`Expected JSON but got content-type: ${ct}`);
      }
      return res.json();
    }
    return res.text();
  }
}
const throttler = new RequestThrottler();
// ─── Router ──────────────────────────────────────────────────────────────────
function getPageType() {
  const path = window.location.pathname;
  if (/^\/?$/.test(path)) return "home";
  if (/^\/anime\/[^/]+\/?$/.test(path)) return "episode-list";
  if (/^\/play\/[^/]+\/[^/]+\/?$/.test(path)) return "player";
  return "other";
}
function getPageSessions() {
  const path = window.location.pathname;
  const playerMatch = path.match(/^\/play\/([^/]+)\/([^/]+)/);
  if (playerMatch) {
    return { animeSession: playerMatch[1], epSession: playerMatch[2] };
  }
  const listMatch = path.match(/^\/anime\/([^/]+)/);
  if (listMatch) {
    return { animeSession: listMatch[1] };
  }
  return null;
}
// ─── Dub-signal detectors (JSON + HTML) ──────────────────────────────────────
function _audioArraySignalsDub(track) {
  if (!track || typeof track !== "object") return false;
  for (const [k, v] of Object.entries(track)) {
    const lk = k.toLowerCase();
    if (
      (lk === "lang" || lk === "language" || lk === "code") &&
      typeof v === "string"
    ) {
      const lv = v.trim().toLowerCase();
      if (AUDIO_DUB_VALUES.has(lv) || lv === "en") return true;
    }
    if (
      lk === "label" &&
      typeof v === "string" &&
      /\benglish\b|\bdub\b/i.test(v)
    ) {
      return true;
    }
  }
  return false;
}
function _jsonSignalsDub(node) {
  if (node === null || node === undefined) return false;
  if (Array.isArray(node)) return node.some(_jsonSignalsDub);
  if (typeof node === "object") {
    for (const [key, val] of Object.entries(node)) {
      const lk = key.toLowerCase();
      if (lk === "audio") {
        if (
          typeof val === "string" &&
          AUDIO_DUB_VALUES.has(val.trim().toLowerCase())
        ) {
          return true;
        }
        if (Array.isArray(val) && val.some(_audioArraySignalsDub)) return true;
      }
      if ((lk === "dub" || lk === "dubbed") && val != null) return true;
      if (typeof val === "object" && val !== null && _jsonSignalsDub(val))
        return true;
    }
    return false;
  }
  return false;
}
function _htmlSignalsDub(html, doc) {
  for (const el of Array.from(
    doc.querySelectorAll("[data-audio],[data-lang],[data-dub]"),
  )) {
    const ds = el.dataset;
    const v = (ds.audio || ds.lang || ds.dub || "").trim().toLowerCase();
    if (AUDIO_DUB_VALUES.has(v) || v === "en") return true;
  }
  const area =
    doc.getElementById("pickDownload") || doc.getElementById("scrollArea");
  if (area) {
    const txt = area.textContent || "";
    if (/\bDub\b(?!\s*(?:bed|bing|subtitle|sub\b))/i.test(txt)) return true;
    if (
      /\b(?:English|Eng)\b(?!\s*(?:sub|subtitle|subtitles|subbed|dub\s+sub))/i.test(
        txt,
      )
    ) {
      return true;
    }
  }
  const audioFieldRe =
    /['"']?(?:audio|lang|language|dubbed)['"']?\s*:\s*['"](?:eng|en|english|dub|dubbed)['"]/i;
  const audioProximityRe =
    /['"']?audio['"']?\s*:[^;{}]{0,80}['"](?:eng|en|english|dub|dubbed)['"]/i;
  for (const s of Array.from(doc.querySelectorAll("script:not([src])"))) {
    const t = s.textContent || "";
    if (audioFieldRe.test(t) || audioProximityRe.test(t)) return true;
  }
  const lhtml = html.toLowerCase();
  const needles = ['"audio":', "'audio':"];
  for (const needle of needles) {
    let pos = 0;
    while ((pos = lhtml.indexOf(needle, pos)) !== -1) {
      const snippet = lhtml.slice(pos, pos + 60);
      if (/["'](eng|en|english|dub|dubbed)["']/.test(snippet)) return true;
      pos += needle.length;
    }
  }
  return false;
}
// ─── Status pill ─────────────────────────────────────────────────────────────
class StatusPill {
  constructor() {
    this._timer = null;
    const existing = document.getElementById(PILL_ID);
    if (existing) {
      this._el = existing;
    } else {
      this._el = document.createElement("div");
      this._el.id = PILL_ID;
      Object.assign(this._el.style, {
        position: "fixed",
        bottom: "14px",
        right: "14px",
        zIndex: "2147483647",
        background: "rgba(8,8,22,0.92)",
        color: "#e8e8f8",
        font: "700 11px/1.5 system-ui,sans-serif",
        padding: "6px 14px",
        borderRadius: "20px",
        pointerEvents: "none",
        transition: "opacity 0.45s",
        maxWidth: "360px",
        textAlign: "right",
        border: "1px solid rgba(255,255,255,0.08)",
        backdropFilter: "blur(6px)",
        opacity: "0",
        fontVariantNumeric: "tabular-nums",
      });
      document.body.appendChild(this._el);
    }
  }
  show(text, autohideMs = 0, live = false) {
    if (!live) {
      if (this._timer) clearTimeout(this._timer);
    }
    this._el.textContent = text;
    this._el.style.opacity = "1";
    if (autohideMs > 0) {
      this._timer = setTimeout(() => {
        this._el.style.opacity = "0";
      }, autohideMs);
    }
  }
  hide() {
    if (this._timer) clearTimeout(this._timer);
    this._el.style.opacity = "0";
  }
}
// ─── Advanced Settings panel (in-page modal) ─────────────────────────────────
class SettingsPanel {
  constructor(pill, onChanged) {
    this._pill = pill;
    this._onChanged = onChanged;
    this._pending = {};
  }
  open() {
    if (document.getElementById(SETTINGS_PANEL_ID)) return;
    this._build();
  }
  _build() {
    const settings = storage.getSettings();
    // overlay
    const overlay = document.createElement("div");
    overlay.id = SETTINGS_OVERLAY_ID;
    // panel
    const panel = document.createElement("div");
    panel.id = SETTINGS_PANEL_ID;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "ape-dub-settings-title");
    // header
    const header = document.createElement("div");
    header.className = "ape-set-header";
    const titleBox = document.createElement("div");
    titleBox.className = "ape-set-title-box";
    const title = document.createElement("div");
    title.id = "ape-dub-settings-title";
    title.className = "ape-set-title";
    title.textContent = "DUB Detector Plus - Advanced Settings";
    const sub = document.createElement("div");
    sub.className = "ape-set-sub";
    const handler = GM_info?.scriptHandler ?? "your script manager";
    const ver = GM_info?.version ?? "";
    sub.textContent = `Running on ${handler}${ver ? ` v${ver}` : ""}`;
    titleBox.appendChild(title);
    titleBox.appendChild(sub);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "ape-set-close";
    closeBtn.setAttribute("aria-label", "Close settings");
    closeBtn.innerHTML =
      '<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M3.75 3.75 12.25 12.25 M12.25 3.75 3.75 12.25" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    closeBtn.addEventListener("click", () => this.close());
    header.appendChild(titleBox);
    header.appendChild(closeBtn);
    panel.appendChild(header);
    // toggles row
    const togglesWrap = document.createElement("div");
    togglesWrap.className = "ape-set-toggles";
    togglesWrap.appendChild(
      this._buildToggleRow(
        "dubEnabled",
        "DUB Detector",
        "Master switch for the entire detector.",
        settings.dubEnabled,
        (v) => storage.setSettings({ dubEnabled: v }),
      ),
    );
    togglesWrap.appendChild(
      this._buildToggleRow(
        "showSubOnlyBadges",
        "Show SUB-ONLY badges",
        "When on, episodes / cards without a dub get an orange SUB ONLY tag. Off = only DUB badges are shown.",
        settings.showSubOnlyBadges,
        (v) => storage.setSettings({ showSubOnlyBadges: v }),
      ),
    );
    panel.appendChild(togglesWrap);
    // advanced warning
    const warn = document.createElement("div");
    warn.className = "ape-set-warn";
    warn.textContent =
      "These control internal timing, caching, and request behavior. Defaults work well for almost everyone - change with care. Edits below aren't saved until you press Apply Changes.";
    panel.appendChild(warn);
    // advanced groups — collapsible, in their own scrollable region so the
    // header/toggles/footer stay put while this part scrolls
    this._pending = {};
    const scrollWrap = document.createElement("div");
    scrollWrap.className = "ape-set-scroll";
    const groups = document.createElement("div");
    groups.className = "ape-set-groups";
    for (const group of ADVANCED_SETTINGS_SCHEMA) {
      groups.appendChild(this._buildGroup(group, settings));
    }
    scrollWrap.appendChild(groups);
    panel.appendChild(scrollWrap);
    // reset all
    const resetAll = document.createElement("button");
    resetAll.type = "button";
    resetAll.className = "ape-set-reset-all";
    resetAll.textContent = "Reset All Advanced Settings";
    resetAll.addEventListener("click", () => {
      if (
        !confirm(
          "Reset every advanced setting back to its default value? This won't change the feature toggles above.",
        )
      ) {
        return;
      }
      storage.resetAdvanced();
      this._pill.show("🎙 DUB: settings reset ✓", 2500);
      this.close();
      this._onChanged();
    });
    const resetRow = document.createElement("div");
    resetRow.className = "ape-set-reset-row";
    resetRow.appendChild(resetAll);
    panel.appendChild(resetRow);
    // cache actions
    const cacheRow = document.createElement("div");
    cacheRow.className = "ape-set-cache-row";
    const cacheBtn = document.createElement("button");
    cacheBtn.type = "button";
    cacheBtn.className = "ape-set-cache-btn";
    const cached = [
      ...storage.keysWithPrefix(EP_PREFIX),
      ...storage.keysWithPrefix(HOME_PREFIX),
    ].length;
    cacheBtn.textContent = `Clear DUB cache (${cached} entries)`;
    cacheBtn.addEventListener("click", () => {
      const n = clearDubCache();
      this._pill.show(`🎙 DUB: cleared ${n} cached entries`, 2500);
      cacheBtn.textContent = "Clear DUB cache (0 entries)";
    });
    cacheRow.appendChild(cacheBtn);
    panel.appendChild(cacheRow);
    // apply bar — advanced-setting edits are staged and only take effect
    // once this is pressed
    const applyBar = document.createElement("div");
    applyBar.className = "ape-set-apply-bar";
    const applyStatus = document.createElement("span");
    applyStatus.className = "ape-set-apply-status";
    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "ape-set-apply-btn";
    applyBtn.textContent = "Apply Changes";
    applyBtn.disabled = true;
    applyBtn.addEventListener("click", () => this._applyPending());
    applyBar.appendChild(applyStatus);
    applyBar.appendChild(applyBtn);
    panel.appendChild(applyBar);
    this._applyBtn = applyBtn;
    this._applyStatus = applyStatus;
    this._updateApplyState();
    // footer
    const footer = document.createElement("div");
    footer.className = "ape-set-footer";
    footer.textContent =
      "Feature toggles above save instantly. Reload the page after any change to apply it.";
    panel.appendChild(footer);
    overlay.appendChild(panel);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });
    document.body.appendChild(overlay);
    // esc to close
    const onKey = (e) => {
      if (e.key === "Escape") {
        this.close();
        document.removeEventListener("keydown", onKey);
      }
    };
    document.addEventListener("keydown", onKey);
    // focus the close button for keyboard users
    setTimeout(() => closeBtn.focus(), 50);
  }
  _buildGroup(group, settings) {
    const groupEl = document.createElement("div");
    groupEl.className = "ape-set-group";

    const headerBtn = document.createElement("div");
    headerBtn.className = "ape-set-group-header";
    headerBtn.setAttribute("role", "button");
    headerBtn.setAttribute("tabindex", "0");
    headerBtn.setAttribute("aria-expanded", "false");

    const title = document.createElement("span");
    title.className = "ape-set-group-title";
    title.textContent = group.group;

    const count = document.createElement("span");
    count.className = "ape-set-group-count";
    count.textContent = String(group.items.length);

    const chevron = document.createElement("span");
    chevron.className = "ape-set-group-chevron";
    chevron.innerHTML =
      '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg>';

    headerBtn.appendChild(title);
    headerBtn.appendChild(count);
    headerBtn.appendChild(chevron);

    const body = document.createElement("div");
    body.className = "ape-set-group-body";
    body.hidden = true;
    for (const item of group.items) {
      body.appendChild(this._buildNumberRow(item, settings[item.key]));
    }

    const toggleOpen = () => {
      const open = groupEl.classList.toggle("open");
      body.hidden = !open;
      headerBtn.setAttribute("aria-expanded", String(open));
    };
    headerBtn.addEventListener("click", toggleOpen);
    headerBtn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleOpen();
      }
    });

    groupEl.appendChild(headerBtn);
    groupEl.appendChild(body);
    return groupEl;
  }
  _updateApplyState() {
    const count = Object.keys(this._pending).length;
    if (!this._applyBtn) return;
    this._applyBtn.disabled = count === 0;
    this._applyBtn.classList.remove("saved");
    if (count === 0) {
      this._applyBtn.textContent = "Apply Changes";
      this._applyStatus.textContent = "";
      this._applyStatus.classList.remove("pending");
    } else {
      this._applyBtn.textContent = `Apply Changes (${count})`;
      this._applyStatus.textContent = `${count} unsaved change${count === 1 ? "" : "s"}`;
      this._applyStatus.classList.add("pending");
    }
  }
  _applyPending() {
    if (Object.keys(this._pending).length === 0) return;
    storage.setSettings(this._pending);
    this._pending = {};
    document
      .querySelectorAll(`#${SETTINGS_PANEL_ID} .ape-set-row.dirty`)
      .forEach((row) => row.classList.remove("dirty"));
    this._applyBtn.textContent = "Applied ✓";
    this._applyBtn.classList.add("saved");
    this._applyBtn.disabled = true;
    this._applyStatus.textContent = "Saved — reload the page to apply";
    this._applyStatus.classList.remove("pending");
    this._onChanged();
    this._pill.show("🎙 DUB: settings applied ✓", 2200);
    setTimeout(() => this._updateApplyState(), 1600);
  }
  _buildToggleRow(key, label, desc, checked, onSave) {
    const row = document.createElement("div");
    row.className = "ape-set-toggle-row";
    const labelWrap = document.createElement("label");
    labelWrap.className = "ape-set-toggle-label";
    const name = document.createElement("span");
    name.className = "ape-set-toggle-name";
    name.textContent = label;
    const descP = document.createElement("span");
    descP.className = "ape-set-toggle-desc";
    descP.textContent = desc;
    labelWrap.appendChild(name);
    labelWrap.appendChild(descP);
    const toggle = document.createElement("label");
    toggle.className = "ape-set-toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    const track = document.createElement("span");
    track.className = "ape-set-toggle-track";
    const thumb = document.createElement("span");
    thumb.className = "ape-set-toggle-thumb";
    track.appendChild(thumb);
    toggle.appendChild(input);
    toggle.appendChild(track);
    input.addEventListener("change", () => {
      onSave(input.checked);
      row.classList.toggle("off", !input.checked);
      this._onChanged();
    });
    if (!checked) row.classList.add("off");
    row.appendChild(labelWrap);
    row.appendChild(toggle);
    return row;
  }
  _buildNumberRow(item, currentValue) {
    const row = document.createElement("div");
    row.className = "ape-set-row";
    row.dataset.key = item.key;
    const top = document.createElement("div");
    top.className = "ape-set-row-top";
    const label = document.createElement("label");
    label.className = "ape-set-row-label";
    const dirtyDot = document.createElement("span");
    dirtyDot.className = "ape-set-dirty-dot";
    dirtyDot.title = "Unapplied change";
    const labelText = document.createElement("span");
    labelText.textContent = item.label;
    label.appendChild(dirtyDot);
    label.appendChild(labelText);
    label.setAttribute("for", `adv-${item.key}`);
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "ape-set-reset-btn";
    resetBtn.title = `Reset to default (${item.default})`;
    resetBtn.setAttribute("aria-label", `Reset ${item.label} to default`);
    resetBtn.innerHTML =
      '<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8 2.5a5.5 5.5 0 1 0 5.16 7.4.75.75 0 0 1 1.41.5A7 7 0 1 1 8 1c1.77 0 3.36.71 4.53 1.86V1.75a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-.75.75h-3.5a.75.75 0 0 1 0-1.5h1.7A5.48 5.48 0 0 0 8 2.5Z"/></svg>';
    top.appendChild(label);
    top.appendChild(resetBtn);
    const desc = document.createElement("p");
    desc.className = "ape-set-row-desc";
    desc.textContent = item.desc;
    const input = document.createElement("input");
    input.type = "number";
    input.id = `adv-${item.key}`;
    input.className = "ape-set-row-input";
    input.min = String(item.min);
    input.max = String(item.max);
    input.step = String(item.step);
    input.value = String(currentValue ?? item.default);
    // Edits are staged into this._pending, not saved directly — nothing
    // takes effect until "Apply Changes" is pressed.
    const stage = (value) => {
      value = Math.min(item.max, Math.max(item.min, value));
      input.value = String(value);
      const current = storage.getSettings()[item.key];
      if (value === current) {
        delete this._pending[item.key];
        row.classList.remove("dirty");
      } else {
        this._pending[item.key] = value;
        row.classList.add("dirty");
      }
      this._updateApplyState();
    };
    const commit = () => {
      let value = Number(input.value);
      if (!Number.isFinite(value)) value = item.default;
      stage(value);
    };
    input.addEventListener("change", commit);
    input.addEventListener("blur", commit);
    resetBtn.addEventListener("click", () => stage(item.default));
    row.appendChild(top);
    row.appendChild(desc);
    row.appendChild(input);
    return row;
  }
  close() {
    document.getElementById(SETTINGS_PANEL_ID)?.remove();
    document.getElementById(SETTINGS_OVERLAY_ID)?.remove();
  }
}
// ─── DUB Detector ────────────────────────────────────────────────────────────
class DubDetector {
  constructor(settings, pill) {
    this._episodeListObserver = null;
    this._homeObserver = null;
    this._homeBusy = false;
    this._scanStart = 0;
    this._reqCompleted = 0;
    this._etaInterval = null;
    this._pillBaseText = "";
    this._activeSearches = new Map();
    this._searchIdCounter = 0;
    this._maxTotalReqs = 0;
    this._itemsScanned = 0;
    this._totalItems = 0;
    this._inFlight = new Map();
    this._settings = settings;
    this._pill = pill;
    this._parallelProbes = settings.dubParallelProbes;
    this._batchDelay = settings.dubBatchDelay;
    this._homeBatchSize = settings.dubHomeBatchSize;
    this._cacheTtlMs = settings.cacheTtlHours * 60 * 60 * 1000;
  }
  refreshSettings(settings) {
    this._settings = settings;
    this._parallelProbes = settings.dubParallelProbes;
    this._batchDelay = settings.dubBatchDelay;
    this._homeBatchSize = settings.dubHomeBatchSize;
    this._cacheTtlMs = settings.cacheTtlHours * 60 * 60 * 1000;
    throttler.updateOptions(settings);
  }
  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }
  async _batchProcess(items, fn, batchSize, batchDelayMs) {
    const chunks = items.reduce((acc, item, index) => {
      const chunkIndex = Math.floor(index / batchSize);
      if (!acc[chunkIndex]) acc[chunkIndex] = [];
      acc[chunkIndex].push(item);
      return acc;
    }, []);
    await chunks.reduce(async (chain, batch, index) => {
      await chain;
      const results = await Promise.all(batch.map((item) => fn(item)));
      const allCached = results.every((r) => r?.cached);
      const anyNoDub = results.some((r) => !r?.hasDub);
      const skipDelay = allCached || anyNoDub;
      if (index < chunks.length - 1 && !skipDelay) {
        await this._delay(batchDelayMs);
      }
    }, Promise.resolve());
  }
  async init() {
    throttler.updateOptions(this._settings);
    await this._handleRoute();
    let currentUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== currentUrl) {
        currentUrl = location.href;
        void this._handleRoute();
      }
    }).observe(document.body, { childList: true, subtree: true });
  }
  async _handleRoute() {
    const pageType = getPageType();
    switch (pageType) {
      case "episode-list":
        await this._initEpisodeList();
        break;
      case "player":
        await this._initPlayer();
        break;
      case "home":
        await this._initHome();
        break;
      default:
        this._pill.hide();
        break;
    }
  }
  _getThumbnailTarget(anchor) {
    let img = anchor.querySelector("img");
    if (img) return anchor;
    let p = anchor.parentElement;
    for (let d = 0; p && d < 4; d++) {
      img = p.querySelector("img");
      if (img) break;
      p = p.parentElement;
    }
    if (img) return img.closest("a") || img.parentElement || anchor;
    return anchor;
  }
  _startEta(baseText, totalItems = 0) {
    this._stopEta();
    this._scanStart = Date.now();
    this._reqCompleted = 0;
    this._maxTotalReqs = 0;
    this._itemsScanned = 0;
    this._totalItems = totalItems;
    this._pillBaseText = baseText;
    this._tickEta();
    if (totalItems === 0) {
      this._etaInterval = setInterval(() => this._tickEta(), 50);
    }
  }
  _stopEta() {
    if (this._etaInterval) {
      clearInterval(this._etaInterval);
      this._etaInterval = null;
    }
  }
  _itemCompleted() {
    this._itemsScanned++;
    this._tickEta();
  }
  _tickEta() {
    if (this._totalItems > 0) {
      let pct = Math.floor((this._itemsScanned / this._totalItems) * 100);
      pct = Math.max(
        0,
        Math.min(this._itemsScanned === this._totalItems ? 100 : 99, pct),
      );
      this._pill.show(`${this._pillBaseText}  ·  ${pct}%`, 0, true);
      return;
    }
    let searchPending = 0;
    for (const size of this._activeSearches.values()) {
      if (size > 1) {
        const depth = Math.ceil(
          Math.log(size) / Math.log(this._parallelProbes),
        );
        searchPending += depth * (this._parallelProbes - 1);
      }
    }
    const pending = throttler.pendingCount + searchPending;
    const currentTotal = this._reqCompleted + pending;
    if (currentTotal > this._maxTotalReqs) this._maxTotalReqs = currentTotal;
    let pctStr = "";
    if (this._maxTotalReqs > 0) {
      let pct = Math.floor((this._reqCompleted / this._maxTotalReqs) * 100);
      pct = Math.max(
        0,
        Math.min(pending === 0 && this._reqCompleted > 0 ? 100 : 99, pct),
      );
      pctStr = `  ·  ${pct}%`;
    }
    this._pill.show(`${this._pillBaseText}${pctStr}`, 0, true);
  }
  async _initEpisodeList() {
    const sessions = getPageSessions();
    if (!sessions) return;
    this._pill.show("🎙 DUB: Scanning…");
    await this._scanEpisodeList(sessions.animeSession);
    if (!this._episodeListObserver) {
      let debounceTimer = null;
      this._episodeListObserver = new MutationObserver(() => {
        if (debounceTimer) return;
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          const s = getPageSessions();
          if (s) void this._scanEpisodeList(s.animeSession);
        }, 100);
      });
      this._episodeListObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }
  }
  async _scanEpisodeList(animeSession) {
    const cards = Array.from(
      document.querySelectorAll(
        ".episode-list-wrapper a, .episode-grid a, a[href*='/play/']",
      ),
    ).filter((a) => !a.closest("#ape-cw-section"));
    if (!cards.length) return;
    const episodes = [];
    const seenSessions = new Set();
    for (const a of cards) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/play\/[^/]+\/([^/?#]+)/);
      if (!m) continue;
      const epSession = m[1];
      const target = this._getThumbnailTarget(a);
      if (target.dataset.apeDubDone) continue;
      target.dataset.apeDubDone = "1";
      if (!seenSessions.has(epSession)) {
        seenSessions.add(epSession);
        episodes.push({ el: target, epSession });
      }
    }
    if (!episodes.length) return;
    episodes.reverse();
    this._startEta("🎙 DUB: Scanning");
    const dubCount = await this._binarySearchAndBadge(animeSession, episodes);
    this._stopEta();
    this._pill.show(
      dubCount > 0
        ? `🎙 DUB: ${dubCount} episode${dubCount === 1 ? "" : "s"} dubbed ✓`
        : "🎙 DUB: no dub found",
      4500,
    );
  }
  async _binarySearchAndBadge(animeSession, episodes) {
    const boundaryCount = await this._findBoundaryConcurrent(
      animeSession,
      episodes,
      (ep) => ep.epSession,
    );
    for (let i = 0; i < boundaryCount; i++) {
      this._addEpBadge(episodes[i].el);
    }
    if (this._settings.showSubOnlyBadges) {
      for (let i = boundaryCount; i < episodes.length; i++) {
        this._addSubEpBadge(episodes[i].el);
      }
    }
    return boundaryCount;
  }
  async _initPlayer() {
    const sessions = getPageSessions();
    if (!sessions || !sessions.epSession) return;
    document.querySelector(".ape-dub-inline")?.remove();
    document.querySelector(".ape-sub-inline")?.remove();
    this._startEta("🎙 DUB: Checking");
    const dubbed = await this._isEpisodeDubbed(
      sessions.animeSession,
      sessions.epSession,
    );
    this._stopEta();
    if (dubbed) {
      this._addPlayerBadge();
      this._pill.show("🎙 DUB: Dubbed ✓", 5000);
    } else {
      if (this._settings.showSubOnlyBadges) this._addSubPlayerBadge();
      this._pill.show("🎙 DUB: Sub only", 4000);
    }
  }
  _addPlayerBadge() {
    const h1 = document.querySelector("h1");
    if (!h1 || h1.querySelector(".ape-dub-inline")) return;
    const badge = document.createElement("span");
    badge.className = "ape-dub-inline";
    badge.textContent = "DUB";
    badge.style.cssText =
      "background:#d92558;color:#fff;font:700 11px system-ui,sans-serif;" +
      "padding:3px 9px;border-radius:3px;margin-left:10px;vertical-align:middle;" +
      "display:inline-block;box-shadow:0 1px 5px rgba(0,0,0,.5);letter-spacing:.5px;";
    h1.appendChild(badge);
  }
  _addSubPlayerBadge() {
    const h1 = document.querySelector("h1");
    if (
      !h1 ||
      h1.querySelector(".ape-sub-inline") ||
      h1.querySelector(".ape-dub-inline")
    )
      return;
    const badge = document.createElement("span");
    badge.className = "ape-sub-inline";
    badge.textContent = "SUB ONLY";
    badge.style.cssText =
      "background:#e8710a;color:#fff;font:700 11px system-ui,sans-serif;" +
      "padding:3px 9px;border-radius:3px;margin-left:10px;vertical-align:middle;" +
      "display:inline-block;box-shadow:0 1px 5px rgba(0,0,0,.5);letter-spacing:.5px;";
    h1.appendChild(badge);
  }
  async _initHome() {
    const scanHomeCards = async () => {
      if (this._homeBusy) return;
      this._homeBusy = true;
      const cards = Array.from(
        document.querySelectorAll('a[href*="/anime/"], a[href*="/play/"]'),
      ).filter(
        (a) =>
          !a.closest("#ape-cw-section") &&
          !a.closest(
            ".ui-autocomplete, .search-results, header, .top-header, form",
          ),
      );
      if (!cards.length) {
        this._homeBusy = false;
        return;
      }
      const work = [];
      const seenSessions = new Set();
      for (const a of cards) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/(?:\/anime\/|\/play\/)([^/?#]+)/);
        if (!m) continue;
        const animeSession = m[1];
        const target = this._getThumbnailTarget(a);
        if (target.dataset.apeDubDone) continue;
        target.dataset.apeDubDone = "1";
        if (!seenSessions.has(animeSession)) {
          seenSessions.add(animeSession);
          work.push({ anchor: target, animeSession });
        }
      }
      if (work.length > 0) {
        this._startEta("🎙 DUB: Scanning home", work.length);
        await this._batchProcess(
          work,
          (item) => this._scanHomeCard(item),
          this._homeBatchSize,
          this._batchDelay,
        );
        this._stopEta();
        this._pill.show("🎙 DUB: scan complete ✓", 4000);
      }
      this._homeBusy = false;
    };
    await scanHomeCards();
    if (!this._homeObserver) {
      let debounce = null;
      this._homeObserver = new MutationObserver(() => {
        if (!this._homeBusy) {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => void scanHomeCards(), 100);
        }
      });
      this._homeObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }
  }
  async _scanHomeCard(ref) {
    const cached = readCache(homeCacheKey(ref.animeSession), this._cacheTtlMs);
    if (cached) {
      this._addHomeBadge(ref.anchor, cached.dubs, cached.total);
      this._itemCompleted();
      return { cached: true, hasDub: cached.dubs > 0 };
    }
    this._setSpinner(ref.anchor, true);
    let hasDub = false;
    try {
      const stats = await this._fetchAnimeStats(ref.animeSession);
      if (stats) {
        writeCache(homeCacheKey(ref.animeSession), stats);
        this._addHomeBadge(ref.anchor, stats.dubs, stats.total);
        hasDub = stats.dubs > 0;
      }
    } catch {
      // swallow; cache miss + error → no badge
    } finally {
      this._setSpinner(ref.anchor, false);
    }
    this._itemCompleted();
    return { cached: false, hasDub };
  }
  async _fetchAnimeStats(animeSession) {
    let data;
    try {
      data = await this._apiFetch(
        `/api?m=release&id=${animeSession}&sort=episode_asc&page=1`,
        true,
      );
    } catch {
      return null;
    }
    const total =
      (typeof data.total === "number" ? data.total : 0) ||
      (Array.isArray(data.data) ? data.data.length : 0);
    if (!total) return null;
    const eps = Array.isArray(data.data)
      ? data.data
      : Object.values(data.data || {});
    if (!eps.length) return { dubs: 0, total };
    const dubs = await this._findDubCountBinary(animeSession, eps);
    return { dubs, total };
  }
  async _findBoundaryConcurrent(animeSession, eps, sessionExtractor) {
    if (!eps.length) return 0;
    const check = (idx) =>
      this._isEpisodeDubbed(animeSession, sessionExtractor(eps[idx]));
    if (eps.length === 1) return (await check(0)) ? 1 : 0;
    const reqsBeforeInitial = this._reqCompleted;
    const [firstDubbed, lastDubbed] = await Promise.all([
      check(0),
      check(eps.length - 1),
    ]);
    const initialWasCached = this._reqCompleted === reqsBeforeInitial;
    if (!firstDubbed) return 0;
    if (lastDubbed) return eps.length;
    if (!initialWasCached) {
      await this._delay(this._batchDelay);
    }
    const searchId = ++this._searchIdCounter;
    let left = 0;
    let right = eps.length - 1;
    while (right - left > 1) {
      this._activeSearches.set(searchId, right - left);
      this._tickEta();
      const step = (right - left) / this._parallelProbes;
      const probeIndices = [];
      for (let i = 1; i < this._parallelProbes; i++) {
        const mid = Math.floor(left + step * i);
        if (mid > left && mid < right && !probeIndices.includes(mid))
          probeIndices.push(mid);
      }
      if (probeIndices.length === 0) {
        const mid = Math.floor((left + right) / 2);
        if (mid > left && mid < right) probeIndices.push(mid);
        else break;
      }
      const reqsBeforeProbes = this._reqCompleted;
      const results = await Promise.all(probeIndices.map(check));
      const probesWereCached = this._reqCompleted === reqsBeforeProbes;
      let lastTrueIdx = -1;
      for (let i = 0; i < results.length; i++) {
        if (results[i]) lastTrueIdx = i;
        else break;
      }
      if (lastTrueIdx === -1) {
        right = probeIndices[0];
      } else if (lastTrueIdx === probeIndices.length - 1) {
        left = probeIndices[lastTrueIdx];
      } else {
        left = probeIndices[lastTrueIdx];
        right = probeIndices[lastTrueIdx + 1];
      }
      if (right - left > 1 && !probesWereCached) {
        await this._delay(this._batchDelay);
      }
    }
    this._activeSearches.delete(searchId);
    this._tickEta();
    return left + 1;
  }
  async _findDubCountBinary(animeSession, eps) {
    return this._findBoundaryConcurrent(animeSession, eps, (ep) => {
      const e = ep;
      return e.session || e.anime_session || "";
    });
  }
  _addEpBadge(el) {
    if (el.querySelector(".ape-dub-badge-ep")) return;
    const badge = document.createElement("span");
    badge.className = "ape-dub-badge ape-dub-badge-ep";
    badge.textContent = "DUB";
    if (getComputedStyle(el).position === "static") {
      el.style.setProperty("position", "relative", "important");
    }
    el.appendChild(badge);
  }
  _addSubEpBadge(el) {
    if (el.querySelector(".ape-dub-badge-ep")) return;
    if (el.querySelector(".ape-sub-badge-ep")) return;
    const badge = document.createElement("span");
    badge.className = "ape-dub-badge ape-sub-badge-ep";
    badge.textContent = "SUB ONLY";
    badge.style.setProperty("background", "#e8710a", "important");
    if (getComputedStyle(el).position === "static") {
      el.style.setProperty("position", "relative", "important");
    }
    el.appendChild(badge);
  }
  _addHomeBadge(el, dubs, total) {
    if (el.querySelector(".ape-dub-badge-home")) return;
    if (dubs <= 0 && !this._settings.showSubOnlyBadges) return;
    const badge = document.createElement("span");
    badge.className = "ape-dub-badge ape-dub-badge-home";
    if (dubs > 0) {
      badge.textContent = `🎙 ${dubs}/${total}`;
    } else {
      badge.textContent = "SUB ONLY";
      badge.style.setProperty("background", "#e8710a", "important");
    }
    if (getComputedStyle(el).position === "static") {
      el.style.setProperty("position", "relative", "important");
    }
    el.appendChild(badge);
  }
  _setSpinner(el, on) {
    if (on) {
      if (el.querySelector(".ape-dub-spin")) return;
      const s = document.createElement("span");
      s.className = "ape-dub-spin";
      if (getComputedStyle(el).position === "static") {
        el.style.setProperty("position", "relative", "important");
      }
      el.appendChild(s);
    } else {
      el.querySelector(".ape-dub-spin")?.remove();
    }
  }
  async _apiFetch(url, wantJson = true) {
    const result = await throttler.fetch(url, wantJson);
    this._reqCompleted++;
    this._tickEta();
    return result;
  }
  async _isEpisodeDubbed(animeSession, epSession) {
    const cached = readCache(epCacheKey(epSession), this._cacheTtlMs);
    if (cached !== null) return cached;
    if (this._inFlight.has(epSession)) {
      return this._inFlight.get(epSession);
    }
    const promise = this._fetchDubStatus(animeSession, epSession);
    this._inFlight.set(epSession, promise);
    try {
      return await promise;
    } finally {
      this._inFlight.delete(epSession);
    }
  }
  async _fetchDubStatus(animeSession, epSession) {
    let dubbed = null;
    let apiError = null;
    try {
      dubbed = await this._checkDubViaApi(animeSession, epSession);
    } catch (err) {
      // eslint-disable-next-line no-unused-vars
      apiError = err;
      const e = err;
      if (e.rateLimited) return false;
    }
    if (dubbed === null) {
      try {
        dubbed = await this._checkDubViaHtml(animeSession, epSession);
      } catch {
        return false;
      }
    }
    writeCache(epCacheKey(epSession), dubbed);
    return dubbed;
  }
  async _checkDubViaApi(animeSession, epSession) {
    const data = await this._apiFetch(
      `/api?m=links&id=${animeSession}&session=${epSession}&p=kwik`,
      true,
    );
    return _jsonSignalsDub(data);
  }
  async _checkDubViaHtml(animeSession, epSession) {
    const html = await this._apiFetch(
      `/play/${animeSession}/${epSession}`,
      false,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    return _htmlSignalsDub(html, doc);
  }
}
// ─── Bootstrap ───────────────────────────────────────────────────────────────
(function bootstrap() {
  "use strict";
  // Inject styles (badges, spinner, settings panel)
  const css = `
@keyframes ape-dub-spin { to { transform: rotate(360deg); } }

.ape-dub-badge,
.ape-dub-badge-home {
  position:       absolute !important;
  top:            5px      !important;
  right:          5px      !important;
  left:           auto     !important;
  z-index:        9999     !important;
  color:          #fff     !important;
  font:           700 10px/1 system-ui, sans-serif !important;
  padding:        3px 7px  !important;
  border-radius:  3px      !important;
  letter-spacing: .5px     !important;
  pointer-events: none     !important;
  box-shadow:     0 1px 5px rgba(0,0,0,.65) !important;
  display:        inline-block !important;
  text-indent:    0        !important;
  white-space:    nowrap   !important;
}
.ape-dub-badge      { background: #d92558 !important; }
.ape-dub-badge-home { background: #d92558 !important; }

.ape-dub-spin {
  position:       absolute !important;
  top:            7px !important;
  right:          7px !important;
  z-index:        9999 !important;
  width:          10px !important;
  height:         10px !important;
  border-radius:  50%  !important;
  pointer-events: none !important;
  border:         2px solid rgba(255,255,255,.25) !important;
  border-top-color: #fff !important;
  animation:      ape-dub-spin .7s linear infinite !important;
}

/* ─── Advanced Settings modal ─────────────────────────────────────────── */
#${SETTINGS_OVERLAY_ID} {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.6);
  backdrop-filter: blur(3px);
  z-index: 2147483646;
  display: flex; align-items: center; justify-content: center;
  padding: 16px;
  animation: ape-set-fade 0.18s ease;
}
@keyframes ape-set-fade { from { opacity: 0 } to { opacity: 1 } }

#${SETTINGS_PANEL_ID} {
  width: 100%; max-width: 460px;
  max-height: 88vh;
  display: flex; flex-direction: column;
  background: #0b0b1c;
  color: #e4e4f0;
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px;
  font: 13px/1.5 system-ui, -apple-system, sans-serif;
  box-shadow: 0 20px 60px rgba(0,0,0,0.65);
  animation: ape-set-slide 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
  overflow: hidden;
}
@keyframes ape-set-slide {
  from { transform: translateY(8px) scale(0.98); opacity: 0 }
  to   { transform: translateY(0)   scale(1);    opacity: 1 }
}

.ape-set-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 10px;
  padding: 16px 18px 12px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  background: linear-gradient(135deg, rgba(232,113,10,0.06) 0%, rgba(217,37,88,0.06) 100%);
  border-radius: 12px 12px 0 0;
}
.ape-set-title-box { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ape-set-title {
  font-size: 15px; font-weight: 700; color: #f4f4f8; letter-spacing: 0.01em;
}
.ape-set-sub {
  font-size: 11px; color: #7878a0;
}
.ape-set-close {
  flex-shrink: 0;
  width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.08);
  background: transparent; color: #b8b8d0;
  cursor: pointer; transition: background 0.15s, color 0.15s;
}
.ape-set-close svg { width: 14px; height: 14px; }
.ape-set-close:hover { background: rgba(255,255,255,0.1); color: #fff; }

.ape-set-toggles {
  display: flex; flex-direction: column; gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.ape-set-toggle-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px;
  background: #13132a; border: 1px solid rgba(255,255,255,0.07);
  border-radius: 8px; padding: 10px 12px;
}
.ape-set-toggle-row.off { opacity: 0.55; }
.ape-set-toggle-label {
  display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1;
  cursor: pointer;
}
.ape-set-toggle-name { font-size: 13px; font-weight: 600; color: #f0f0f8; }
.ape-set-toggle-desc { font-size: 11px; color: #7878a0; line-height: 1.4; }

.ape-set-toggle { position: relative; flex-shrink: 0; cursor: pointer; }
.ape-set-toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
.ape-set-toggle-track {
  display: block; width: 38px; height: 22px;
  background: rgba(255,255,255,0.1);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 11px; position: relative;
  transition: background 0.25s, border-color 0.25s;
}
.ape-set-toggle input:checked + .ape-set-toggle-track {
  background: #2ecc71; border-color: #2ecc71;
}
.ape-set-toggle-thumb {
  position: absolute; top: 2px; left: 2px;
  width: 16px; height: 16px; background: #fff;
  border-radius: 50%;
  box-shadow: 0 1px 4px rgba(0,0,0,0.4);
  transition: transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.ape-set-toggle input:checked + .ape-set-toggle-track .ape-set-toggle-thumb {
  transform: translateX(16px);
}

.ape-set-warn {
  font-size: 11px; line-height: 1.45;
  color: #e8b24a; background: rgba(232,178,74,0.08);
  border: 1px solid rgba(232,178,74,0.2);
  border-radius: 6px; padding: 8px 10px;
  margin: 12px 14px 0;
}

.ape-set-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 14px 4px;
}
.ape-set-scroll::-webkit-scrollbar { width: 7px; }
.ape-set-scroll::-webkit-scrollbar-track { background: transparent; }
.ape-set-scroll::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,0.12); border-radius: 4px;
}
.ape-set-scroll::-webkit-scrollbar-thumb:hover {
  background: rgba(255,255,255,0.22);
}

.ape-set-groups {
  display: flex; flex-direction: column; gap: 8px;
}
.ape-set-group {
  background: #13132a; border: 1px solid rgba(255,255,255,0.07);
  border-radius: 8px; overflow: hidden;
}
.ape-set-group-header {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px;
  cursor: pointer; user-select: none;
  transition: background 0.15s;
}
.ape-set-group-header:hover { background: rgba(255,255,255,0.04); }
.ape-set-group-title {
  flex: 1;
  font-size: 10px; font-weight: 700; color: #e4e4f0;
  letter-spacing: 0.08em; text-transform: uppercase;
}
.ape-set-group-count {
  font-size: 10px; font-weight: 600; color: #7878a0;
  background: #1a1a34; border-radius: 8px; padding: 1px 6px;
}
.ape-set-group-chevron {
  display: flex; flex-shrink: 0; color: #7878a0;
  transition: transform 0.2s ease;
}
.ape-set-group-chevron svg { width: 11px; height: 11px; }
.ape-set-group.open .ape-set-group-chevron { transform: rotate(180deg); }
.ape-set-group-body {
  display: flex; flex-direction: column; gap: 8px;
  padding: 0 12px 12px;
  border-top: 1px solid rgba(255,255,255,0.06);
  padding-top: 10px;
  margin-top: -1px;
}

.ape-set-row {
  background: #1a1a34; border: 1px solid rgba(255,255,255,0.07);
  border-radius: 6px; padding: 8px 10px;
  display: flex; flex-direction: column; gap: 5px;
  transition: border-color 0.15s;
}
.ape-set-row.dirty { border-color: #e8710a; }
.ape-set-row-top {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.ape-set-row-label {
  font-size: 11.5px; font-weight: 600; color: #e4e4f0;
  display: flex; align-items: center; gap: 6px;
}
.ape-set-dirty-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: #e8710a; flex-shrink: 0; display: none;
}
.ape-set-row.dirty .ape-set-dirty-dot { display: block; }
.ape-set-reset-btn {
  flex-shrink: 0; width: 22px; height: 22px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 5px; border: 1px solid rgba(255,255,255,0.08);
  background: transparent; color: #7878a0;
  cursor: pointer; transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.ape-set-reset-btn svg { width: 12px; height: 12px; }
.ape-set-reset-btn:hover {
  background: rgba(255,255,255,0.1); color: #fff;
  border-color: rgba(255,255,255,0.18);
}
.ape-set-row-desc { font-size: 10.5px; line-height: 1.4; color: #7878a0; margin: 0; }
.ape-set-row-input {
  width: 100%; box-sizing: border-box;
  background: #0b0b1c; border: 1px solid rgba(255,255,255,0.08);
  border-radius: 5px; padding: 5px 8px;
  font-size: 12px; font-family: inherit; color: #e4e4f0;
  font-variant-numeric: tabular-nums;
}
.ape-set-row-input:focus { outline: none; border-color: #e8710a; }

.ape-set-reset-row {
  padding: 0 14px; margin-top: 14px;
  box-sizing: border-box;
}
.ape-set-reset-all {
  width: 100%;
  box-sizing: border-box;
  background: #1a1a34; border: 1px solid rgba(255,255,255,0.08);
  color: #d0a0a0; font-size: 11.5px; font-weight: 600;
  padding: 8px 10px; border-radius: 6px;
  cursor: pointer; transition: background 0.18s, color 0.18s, border-color 0.18s;
}
.ape-set-reset-all:hover {
  background: #c0392b; color: #fff; border-color: transparent;
}

.ape-set-cache-row {
  padding: 0 14px; margin-top: 10px;
}
.ape-set-cache-btn {
  width: 100%;
  background: #1a1a34; border: 1px solid rgba(255,255,255,0.08);
  color: #b8b8d0; font-size: 11.5px; font-weight: 600;
  padding: 8px 10px; border-radius: 6px;
  cursor: pointer; transition: background 0.18s, color 0.18s, border-color 0.18s;
}
.ape-set-cache-btn:hover {
  background: rgba(217,37,88,0.18); color: #fff; border-color: rgba(217,37,88,0.4);
}

.ape-set-apply-bar {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px 0;
  margin-top: 12px;
}
.ape-set-apply-status {
  flex: 1;
  font-size: 10.5px; color: #7878a0;
}
.ape-set-apply-status.pending { color: #e8710a; font-weight: 600; }
.ape-set-apply-btn {
  flex-shrink: 0;
  font-size: 12px; font-weight: 700;
  padding: 8px 16px; border-radius: 6px;
  background: #e8710a; color: #fff; border: 1px solid transparent;
  cursor: pointer;
  transition: background 0.18s, transform 0.1s, opacity 0.18s;
}
.ape-set-apply-btn:hover:not(:disabled) { background: #f57f14; }
.ape-set-apply-btn:active:not(:disabled) { transform: scale(0.97); }
.ape-set-apply-btn:disabled {
  background: #1a1a34; color: #7878a0; cursor: default;
}
.ape-set-apply-btn.saved { background: #2ecc71; }

.ape-set-footer {
  padding: 10px 18px 16px;
  font-size: 11px; color: #7878a0; text-align: center;
  border-top: 1px solid rgba(255,255,255,0.06);
  margin-top: 10px;
}
`;
  try {
    if (typeof GM_addStyle === "function") {
      GM_addStyle(css);
    } else {
      const style = document.createElement("style");
      style.id = "ape-dub-styles";
      style.textContent = css;
      document.head.appendChild(style);
    }
  } catch (err) {
    console.warn("[DUB] failed to inject styles", err);
  }
  // Build core singletons
  const pill = new StatusPill();
  const settings = storage.getSettings();
  const detector = new DubDetector(settings, pill);
  const panel = new SettingsPanel(pill, () => {
    detector.refreshSettings(storage.getSettings());
  });
  // Menu commands
  const registerMenu = (label, fn) => {
    try {
      if (typeof GM_registerMenuCommand === "function") {
        GM_registerMenuCommand(label, fn);
      }
    } catch (err) {
      console.warn("[DUB] menu command failed", label, err);
    }
  };
  registerMenu("⚙️ Open DUB Detector Settings", () => panel.open());
  registerMenu("🗑️ Clear DUB Cache", () => {
    const n = clearDubCache();
    pill.show(`🎙 DUB: cleared ${n} cached entries`, 2500);
    detector.refreshSettings(storage.getSettings());
  });
  registerMenu("♻️ Reset Advanced Settings", () => {
    if (!confirm("Reset every advanced setting back to its default value?"))
      return;
    storage.resetAdvanced();
    detector.refreshSettings(storage.getSettings());
    pill.show("🎙 DUB: advanced settings reset ✓", 2500);
  });
  registerMenu("📊 Show cache stats", () => {
    const ep = storage.keysWithPrefix(EP_PREFIX).length;
    const home = storage.keysWithPrefix(HOME_PREFIX).length;
    const s = storage.getSettings();
    pill.show(
      `🎙 DUB cache: ${ep} ep · ${home} home · TTL ${s.cacheTtlHours}h`,
      4500,
    );
  });
  // Background GC
  setTimeout(() => {
    const removed = gcDubCache(settings.cacheTtlHours * 60 * 60 * 1000);
    if (removed > 0) {
      console.log(`[DUB] GC removed ${removed} stale entries.`);
    }
  }, 2000);
  // Boot the detector
  if (settings.dubEnabled) {
    void detector.init();
  } else {
    pill.show("🎙 DUB: detector disabled (open settings to enable)", 4500);
  }
  // Expose a tiny debugging hook on window (optional)
  window.apeDubDetector = {
    version: "2.0.0",
    openSettings: () => panel.open(),
    clearCache: () => clearDubCache(),
    getSettings: () => storage.getSettings(),
    resetSettings: () => storage.resetAdvanced(),
  };
})();
