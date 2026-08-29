// ==UserScript==
// @name         animepahe-dub-detector-plus
// @namespace    https://github.com/abdullahkhfb/animepahe-dub-detector-plus
// @version      2.2.0
// @description  Tags dubbed episodes on animepahe with DUB/SUB ONLY badges.
// @license      GPLv3
// @author       abdullahkhfb
// @icon         https://raw.githubusercontent.com/abdullahkhfb/animepahe-dub-detector-plus/main/icon/animepahe-dub-detector.svg
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

// The GM_* functions/values below are fixed, unrenamable globals supplied by
// the userscript manager (Tampermonkey/Violentmonkey/etc.) per the
// Greasemonkey API spec, so the naming-convention rules that assume
// project-owned identifiers don't apply to them.
/* eslint-disable camelcase, new-cap */

// Constants.
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
  ".ui-autocomplete, .search-results, header, " +
  ".top-header, form, #search, .autocomplete, .dropdown";
// Tuning constants.
// These used to be user-configurable "Advanced Settings"; they are now fixed
// so the settings panel only exposes the handful of options people actually
// change.
const CACHE_TTL_HOURS = 24;
const CACHE_TTL_MS = CACHE_TTL_HOURS * 60 * 60 * 1000;
const DUB_BATCH_DELAY_MS = 2000;
const DUB_HOME_BATCH_SIZE = 2;
const THROTTLE_MIN_INTERVAL_MS = 120;
const THROTTLE_JITTER_MS = 50;
const THROTTLE_MAX_CONCURRENT = 6;
const THROTTLE_MAX_RETRIES = 4;
const THROTTLE_BASE_BACKOFF_MS = 3000;
// How long to wait after a page loads before the detector makes its first
// network request, on any page type. This gives the site's own scripts a
// head start on whatever they need to fetch, instead of racing them for
// Cloudflare's rate limit budget right at page-load time.
const SCAN_STARTUP_DELAY_MS = 1500;
// Settings schema.
const DEFAULT_SETTINGS = {
  dubEnabled: true,
  showSubOnlyBadges: true,
  scanHomeEnabled: true,
};
// GM-backed storage adapter.
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
};
// Cache module.
/** Parses a raw cache string into its timestamp and value parts. */
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
/** Serializes a value into the versioned cache string format. */
function makeCacheEntry(value) {
  return `${Date.now()}|${CACHE_VERSION}|${JSON.stringify(value)}`;
}
/** Reads a cached value for `key` if it exists and hasn't expired. */
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
/** Writes `value` to the cache under `key` with the current timestamp. */
function writeCache(key, value) {
  storage.set(key, makeCacheEntry(value));
}
/** Builds the storage key for an episode's cached dub status. */
function epCacheKey(epSession) {
  return `${EP_PREFIX}${epSession}`;
}
/** Builds the storage key for an anime's cached homepage stats. */
function homeCacheKey(animeSession) {
  return `${HOME_PREFIX}${animeSession}`;
}
/** Removes cached entries older than `ttlMs` and returns how many. */
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
/** Removes every cached dub-detection entry and returns the count. */
function clearDubCache() {
  const allKeys = [
    ...storage.keysWithPrefix(EP_PREFIX),
    ...storage.keysWithPrefix(HOME_PREFIX),
  ];
  for (const key of allKeys) storage.remove(key);
  return allKeys.length;
}
/** Queues and paces outgoing requests, retrying on rate limits. */
class RequestThrottler {
  /** Creates a throttler with the default pacing/retry settings. */
  constructor() {
    this.queue_ = [];
    this.active_ = 0;
    this.lastLaunch_ = 0;
    this.backoffUntil_ = 0;
    this.draining_ = false;
    this.minInterval_ = THROTTLE_MIN_INTERVAL_MS;
    this.jitter_ = THROTTLE_JITTER_MS;
    this.maxConcurrent_ = THROTTLE_MAX_CONCURRENT;
    this.maxRetries_ = THROTTLE_MAX_RETRIES;
    this.baseBackoff_ = THROTTLE_BASE_BACKOFF_MS;
  }
  /** Queues a request and resolves with its parsed response. */
  fetch(url, wantJson = true) {
    return new Promise((resolve, reject) => {
      this.queue_.push({ url, wantJson, resolve, reject, retries: 0 });
      if (!this.draining_) void this.drain_();
    });
  }
  /** @return {number} How many requests are queued or in flight. */
  get pendingCount() {
    return this.queue_.length + this.active_;
  }
  /** Resolves after `ms` milliseconds. */
  sleep_(ms) {
    return new Promise((r) => setTimeout(r, Math.max(0, ms)));
  }
  /** Continuously launches queued requests within the rate limits. */
  async drain_() {
    this.draining_ = true;
    while (this.queue_.length > 0 || this.active_ > 0) {
      const backoffRemaining = this.backoffUntil_ - Date.now();
      if (backoffRemaining > 0) {
        await this.sleep_(backoffRemaining);
        continue;
      }
      if (this.queue_.length > 0 && this.active_ < this.maxConcurrent_) {
        const jitter =
          Math.floor(Math.random() * this.jitter_ * 2) - this.jitter_;
        const gap = this.minInterval_ + jitter;
        const since = Date.now() - this.lastLaunch_;
        if (since < gap) {
          await this.sleep_(gap - since);
          continue;
        }
        const task = this.queue_.shift();
        this.active_++;
        this.lastLaunch_ = Date.now();
        void this.execute_(task);
        continue;
      }
      await this.sleep_(20);
    }
    this.draining_ = false;
  }
  /** Runs one queued request, requeueing it on a rate-limit error. */
  async execute_(task) {
    try {
      const result = await this.attempt_(task.url, task.wantJson);
      task.resolve(result);
    } catch (err) {
      const e = err;
      if (e.rateLimited && task.retries < this.maxRetries_) {
        const serverHint = e.retryAfterMs ?? 0;
        const expBackoff = this.baseBackoff_ * Math.pow(2, task.retries);
        const jitter = Math.random() * expBackoff * 0.5;
        const delay = Math.max(serverHint, expBackoff + jitter);
        this.backoffUntil_ = Date.now() + delay;
        task.retries++;
        this.queue_.push(task);
      } else {
        task.reject(e);
      }
    } finally {
      this.active_--;
      if (!this.draining_ && (this.queue_.length > 0 || this.active_ > 0)) {
        void this.drain_();
      }
    }
  }
  /** Performs the actual fetch and classifies error responses. */
  async attempt_(url, wantJson) {
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
        // eslint-disable-next-line max-len -- regex literal can't be split
        const cfPattern =
          /cloudflare|checking your browser|just a moment|cf-browser-verification/i;
        const isCf = cfPattern.test(body);
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
// Router.
/** @return {string} Which kind of animepahe page is currently loaded. */
function getPageType() {
  const path = window.location.pathname;
  if (/^\/?$/.test(path)) return "home";
  if (/^\/anime\/[^/]+\/?$/.test(path)) return "episode-list";
  if (/^\/play\/[^/]+\/[^/]+\/?$/.test(path)) return "player";
  return "other";
}
/** @return {?Object} The anime/episode sessions parsed from the URL. */
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
// Dub-signal detectors (JSON + HTML).
/** @return {boolean} Whether an audio-track entry indicates a dub. */
function audioArraySignalsDub(track) {
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
/** @return {boolean} Whether a JSON response signals a dub exists. */
function jsonSignalsDub(node) {
  if (node === null || node === undefined) return false;
  if (Array.isArray(node)) return node.some(jsonSignalsDub);
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
        if (Array.isArray(val) && val.some(audioArraySignalsDub)) return true;
      }
      if ((lk === "dub" || lk === "dubbed") && val != null) return true;
      if (typeof val === "object" && val !== null && jsonSignalsDub(val)) {
        return true;
      }
    }
    return false;
  }
  return false;
}
/** @return {boolean} Whether the rendered HTML signals a dub exists. */
function htmlSignalsDub(html, doc) {
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
    const engPattern =
      /\b(?:English|Eng)\b(?!\s*(?:sub|subtitle|subtitles|subbed|dub\s+sub))/i;
    if (engPattern.test(txt)) {
      return true;
    }
  }
  // eslint-disable-next-line max-len -- regex literal can't be split
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
// Status pill.
/** The small fixed status pill shown in the corner of the page. */
class StatusPill {
  /** Creates or reuses the pill element already in the DOM. */
  constructor() {
    this.timer_ = null;
    const existing = document.getElementById(PILL_ID);
    if (existing) {
      this.el_ = existing;
    } else {
      this.el_ = document.createElement("div");
      this.el_.id = PILL_ID;
      Object.assign(this.el_.style, {
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
      document.body.appendChild(this.el_);
    }
  }
  /** Shows `text` in the pill, optionally auto-hiding it later. */
  show(text, autohideMs = 0, live = false) {
    if (!live) {
      if (this.timer_) clearTimeout(this.timer_);
    }
    this.el_.textContent = text;
    this.el_.style.opacity = "1";
    if (autohideMs > 0) {
      this.timer_ = setTimeout(() => {
        this.el_.style.opacity = "0";
      }, autohideMs);
    }
  }
  /** Hides the pill immediately. */
  hide() {
    if (this.timer_) clearTimeout(this.timer_);
    this.el_.style.opacity = "0";
  }
}
// Settings panel (in-page modal).
/** The in-page Settings modal, built and torn down on demand. */
class SettingsPanel {
  /** @param {!StatusPill} pill @param {function()} onChanged */
  constructor(pill, onChanged) {
    this.pill_ = pill;
    this.onChanged_ = onChanged;
  }
  /** Opens the settings modal if it isn't already open. */
  open() {
    if (document.getElementById(SETTINGS_PANEL_ID)) return;
    this.build_();
  }
  /** Builds and mounts the settings modal's DOM. */
  build_() {
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
    title.textContent = "DUB Detector Plus - Settings";
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
    const dubToggle = this.buildToggleRow_(
      "dubEnabled",
      "DUB Detector",
      "Master switch for the entire detector.",
      settings.dubEnabled,
      (v) => storage.setSettings({ dubEnabled: v }),
    );
    const scanHomeToggle = this.buildToggleRow_(
      "scanHomeEnabled",
      "Scan homepage",
      "When on, homepage cards are automatically checked for a dub as " +
        "you browse.",
      settings.scanHomeEnabled,
      (v) => storage.setSettings({ scanHomeEnabled: v }),
    );
    const subOnlyToggle = this.buildToggleRow_(
      "showSubOnlyBadges",
      "Show SUB-ONLY badges",
      "When on, episodes / cards without a dub get an orange SUB ONLY " +
        "tag. Off = only DUB badges are shown.",
      settings.showSubOnlyBadges,
      (v) => storage.setSettings({ showSubOnlyBadges: v }),
    );
    // The homepage-scan and SUB-ONLY toggles only mean something while the
    // detector itself is running, so disable them whenever the master
    // switch is off.
    scanHomeToggle.setDisabled(!settings.dubEnabled);
    subOnlyToggle.setDisabled(!settings.dubEnabled);
    dubToggle.input.addEventListener("change", () => {
      scanHomeToggle.setDisabled(!dubToggle.input.checked);
      subOnlyToggle.setDisabled(!dubToggle.input.checked);
    });
    togglesWrap.appendChild(dubToggle.row);
    togglesWrap.appendChild(scanHomeToggle.row);
    togglesWrap.appendChild(subOnlyToggle.row);
    panel.appendChild(togglesWrap);
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
      this.pill_.show(`🎙 DUB: cleared ${n} cached entries`, 2500);
      cacheBtn.textContent = "Clear DUB cache (0 entries)";
    });
    cacheRow.appendChild(cacheBtn);
    panel.appendChild(cacheRow);
    // footer
    const footer = document.createElement("div");
    footer.className = "ape-set-footer";
    footer.textContent =
      "Toggles above save instantly. Reload the page after any change to " +
      "apply it.";
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
  /** Builds one labeled on/off toggle row for the settings modal. */
  buildToggleRow_(key, label, desc, checked, onSave) {
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
      this.onChanged_();
    });
    if (!checked) row.classList.add("off");
    row.appendChild(labelWrap);
    row.appendChild(toggle);
    const setDisabled = (disabled) => {
      input.disabled = disabled;
      row.classList.toggle("disabled", disabled);
    };
    return { row, input, setDisabled };
  }
  /** Removes the settings modal from the DOM. */
  close() {
    document.getElementById(SETTINGS_PANEL_ID)?.remove();
    document.getElementById(SETTINGS_OVERLAY_ID)?.remove();
  }
}
// DUB detector.
/** Scans animepahe pages and tags episodes/cards with dub badges. */
class DubDetector {
  /** @param {!Object} settings @param {!StatusPill} pill */
  constructor(settings, pill) {
    this.episodeListObserver_ = null;
    this.homeObserver_ = null;
    this.homeBusy_ = false;
    this.scanStart_ = 0;
    this.reqCompleted_ = 0;
    this.etaInterval_ = null;
    this.pillBaseText_ = "";
    this.activeSearches_ = new Map();
    this.searchIdCounter_ = 0;
    this.maxTotalReqs_ = 0;
    this.itemsScanned_ = 0;
    this.totalItems_ = 0;
    this.inFlight_ = new Map();
    this.settings_ = settings;
    this.pill_ = pill;
    this.batchDelay_ = DUB_BATCH_DELAY_MS;
    this.homeBatchSize_ = DUB_HOME_BATCH_SIZE;
    this.cacheTtlMs_ = CACHE_TTL_MS;
    // Guards against `handleRoute_()` running more than once at a time (see
    // `handleRoute_()` below for why that matters).
    this.routingPromise_ = null;
    this.routeQueued_ = false;
    // Whether the initial post-load startup delay (see `runRoute_()`) has
    // already been applied. Only the very first scan on a freshly loaded
    // page waits; later SPA-style route changes stay responsive.
    this.startupDelayDone_ = false;
  }
  /** Applies newly saved settings without needing a page reload. */
  refreshSettings(settings) {
    this.settings_ = settings;
  }
  /** Resolves after `ms` milliseconds. */
  delay_(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }
  /** Runs `fn` over `items` in batches, pausing between batches. */
  async batchProcess_(items, fn, batchSize, batchDelayMs) {
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
        await this.delay_(batchDelayMs);
      }
    }, Promise.resolve());
  }
  /** Boots the detector and starts watching for SPA navigation. */
  async init() {
    await this.handleRoute_();
    let currentUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== currentUrl) {
        currentUrl = location.href;
        void this.handleRoute_();
      }
    }).observe(document.body, { childList: true, subtree: true });
  }
  /**
   * Runs the scan appropriate for the current page type, serialized so a
   * second navigation detected mid-scan can't run concurrently with (and
   * corrupt the shared ETA/pill state of) one already in progress.
   */
  async handleRoute_() {
    if (this.routingPromise_) {
      this.routeQueued_ = true;
      return this.routingPromise_;
    }
    this.routingPromise_ = this.runRoute_().finally(() => {
      this.routingPromise_ = null;
      if (this.routeQueued_) {
        this.routeQueued_ = false;
        void this.handleRoute_();
      }
    });
    return this.routingPromise_;
  }
  /** Runs the scan for whichever page type is currently loaded. */
  async runRoute_() {
    const pageType = getPageType();
    const willScan =
      pageType === "episode-list" ||
      pageType === "player" ||
      (pageType === "home" && this.settings_.scanHomeEnabled);
    if (willScan && !this.startupDelayDone_) {
      this.startupDelayDone_ = true;
      await this.delay_(SCAN_STARTUP_DELAY_MS);
    }
    switch (pageType) {
      case "episode-list":
        await this.initEpisodeList_();
        break;
      case "player":
        await this.initPlayer_();
        break;
      case "home":
        if (this.settings_.scanHomeEnabled) {
          await this.initHome_();
        } else {
          this.pill_.hide();
        }
        break;
      default:
        this.pill_.hide();
        break;
    }
  }
  /** @return {!Element} The element a badge should be attached to. */
  getThumbnailTarget_(anchor) {
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
  /** Starts (or restarts) the pill's progress/ETA display. */
  startEta_(baseText, totalItems = 0) {
    this.stopEta_();
    this.scanStart_ = Date.now();
    this.reqCompleted_ = 0;
    this.maxTotalReqs_ = 0;
    this.itemsScanned_ = 0;
    this.totalItems_ = totalItems;
    this.pillBaseText_ = baseText;
    this.tickEta_();
    if (totalItems === 0) {
      this.etaInterval_ = setInterval(() => this.tickEta_(), 50);
    }
  }
  /** Stops the pill's progress/ETA display. */
  stopEta_() {
    if (this.etaInterval_) {
      clearInterval(this.etaInterval_);
      this.etaInterval_ = null;
    }
  }
  /** Marks one more item as scanned and refreshes the pill. */
  itemCompleted_() {
    this.itemsScanned_++;
    this.tickEta_();
  }
  /** Recomputes and redraws the pill's progress percentage. */
  tickEta_() {
    if (this.totalItems_ > 0) {
      let pct = Math.floor((this.itemsScanned_ / this.totalItems_) * 100);
      pct = Math.max(
        0,
        Math.min(this.itemsScanned_ === this.totalItems_ ? 100 : 99, pct),
      );
      this.pill_.show(`${this.pillBaseText_}  ·  ${pct}%`, 0, true);
      return;
    }
    let searchPending = 0;
    for (const size of this.activeSearches_.values()) {
      // The search is now a sequential gallop-then-binary-search, so a
      // bracket of `size` remaining episodes takes roughly 2*log2(size)
      // more one-at-a-time requests to resolve (gallop out, then narrow).
      if (size > 1) {
        searchPending += 2 * Math.ceil(Math.log2(size));
      }
    }
    const pending = throttler.pendingCount + searchPending;
    const currentTotal = this.reqCompleted_ + pending;
    if (currentTotal > this.maxTotalReqs_) this.maxTotalReqs_ = currentTotal;
    let pctStr = "";
    if (this.maxTotalReqs_ > 0) {
      let pct = Math.floor((this.reqCompleted_ / this.maxTotalReqs_) * 100);
      pct = Math.max(
        0,
        Math.min(pending === 0 && this.reqCompleted_ > 0 ? 100 : 99, pct),
      );
      pctStr = `  ·  ${pct}%`;
    }
    this.pill_.show(`${this.pillBaseText_}${pctStr}`, 0, true);
  }
  /** Scans an anime's episode-list page for dubbed episodes. */
  async initEpisodeList_() {
    const sessions = getPageSessions();
    if (!sessions) return;
    this.pill_.show("🎙 DUB: Scanning…");
    await this.scanEpisodeList_(sessions.animeSession);
    if (!this.episodeListObserver_) {
      let debounceTimer = null;
      this.episodeListObserver_ = new MutationObserver(() => {
        if (debounceTimer) return;
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          const s = getPageSessions();
          if (s) void this.scanEpisodeList_(s.animeSession);
        }, 100);
      });
      this.episodeListObserver_.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }
  }
  /** Finds episode cards on the page and badges the dubbed ones. */
  async scanEpisodeList_(animeSession) {
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
      const target = this.getThumbnailTarget_(a);
      if (target.dataset.apeDubDone) continue;
      target.dataset.apeDubDone = "1";
      if (!seenSessions.has(epSession)) {
        seenSessions.add(epSession);
        episodes.push({ el: target, epSession });
      }
    }
    if (!episodes.length) return;
    episodes.reverse();
    this.startEta_("🎙 DUB: Scanning");
    const dubCount = await this.binarySearchAndBadge_(animeSession, episodes);
    this.stopEta_();
    this.pill_.show(
      dubCount > 0
        ? `🎙 DUB: ${dubCount} episode${dubCount === 1 ? "" : "s"} dubbed ✓`
        : "🎙 DUB: no dub found",
      4500,
    );
  }
  /** Finds the dub boundary among `episodes` and badges accordingly. */
  async binarySearchAndBadge_(animeSession, episodes) {
    const boundaryCount = await this.findBoundaryConcurrent_(
      animeSession,
      episodes,
      (ep) => ep.epSession,
    );
    for (let i = 0; i < boundaryCount; i++) {
      this.addEpBadge_(episodes[i].el);
    }
    if (this.settings_.showSubOnlyBadges) {
      for (let i = boundaryCount; i < episodes.length; i++) {
        this.addSubEpBadge_(episodes[i].el);
      }
    }
    return boundaryCount;
  }
  /** Checks whether the current episode is dubbed and badges it. */
  async initPlayer_() {
    const sessions = getPageSessions();
    if (!sessions || !sessions.epSession) return;
    document.querySelector(".ape-dub-inline")?.remove();
    document.querySelector(".ape-sub-inline")?.remove();
    this.startEta_("🎙 DUB: Checking");
    const dubbed = await this.isEpisodeDubbed_(
      sessions.animeSession,
      sessions.epSession,
    );
    this.stopEta_();
    if (dubbed) {
      this.addPlayerBadge_();
      this.pill_.show("🎙 DUB: Dubbed ✓", 5000);
    } else {
      if (this.settings_.showSubOnlyBadges) this.addSubPlayerBadge_();
      this.pill_.show("🎙 DUB: Sub only", 4000);
    }
  }
  /** Adds an inline DUB badge next to the player page's title. */
  addPlayerBadge_() {
    const h1 = document.querySelector("h1");
    if (!h1 || h1.querySelector(".ape-dub-inline")) return;
    const badge = document.createElement("span");
    badge.className = "ape-dub-inline";
    badge.textContent = "DUB";
    badge.style.cssText =
      "background:#d92558;color:#fff;font:700 11px system-ui,sans-serif;" +
      "padding:3px 9px;border-radius:3px;margin-left:10px;" +
      "vertical-align:middle;display:inline-block;" +
      "box-shadow:0 1px 5px rgba(0,0,0,.5);letter-spacing:.5px;";
    h1.appendChild(badge);
  }
  /** Adds an inline SUB ONLY badge next to the player page's title. */
  addSubPlayerBadge_() {
    const h1 = document.querySelector("h1");
    if (
      !h1 ||
      h1.querySelector(".ape-sub-inline") ||
      h1.querySelector(".ape-dub-inline")
    ) {
      return;
    }
    const badge = document.createElement("span");
    badge.className = "ape-sub-inline";
    badge.textContent = "SUB ONLY";
    badge.style.cssText =
      "background:#e8710a;color:#fff;font:700 11px system-ui,sans-serif;" +
      "padding:3px 9px;border-radius:3px;margin-left:10px;" +
      "vertical-align:middle;display:inline-block;" +
      "box-shadow:0 1px 5px rgba(0,0,0,.5);letter-spacing:.5px;";
    h1.appendChild(badge);
  }
  /** Scans homepage cards for dubs, watching for newly added ones. */
  async initHome_() {
    const scanHomeCards = async () => {
      if (this.homeBusy_) return;
      this.homeBusy_ = true;
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
        this.homeBusy_ = false;
        return;
      }
      const work = [];
      const seenSessions = new Set();
      for (const a of cards) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/(?:\/anime\/|\/play\/)([^/?#]+)/);
        if (!m) continue;
        const animeSession = m[1];
        const target = this.getThumbnailTarget_(a);
        if (target.dataset.apeDubDone) continue;
        target.dataset.apeDubDone = "1";
        if (!seenSessions.has(animeSession)) {
          seenSessions.add(animeSession);
          work.push({ anchor: target, animeSession });
        }
      }
      if (work.length > 0) {
        this.startEta_("🎙 DUB: Scanning home", work.length);
        await this.batchProcess_(
          work,
          (item) => this.scanHomeCard_(item),
          this.homeBatchSize_,
          this.batchDelay_,
        );
        this.stopEta_();
        this.pill_.show("🎙 DUB: scan complete ✓", 4000);
      }
      this.homeBusy_ = false;
    };
    await scanHomeCards();
    if (!this.homeObserver_) {
      let debounce = null;
      this.homeObserver_ = new MutationObserver(() => {
        if (!this.homeBusy_) {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => void scanHomeCards(), 100);
        }
      });
      this.homeObserver_.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }
  }
  /** Fetches (or reads from cache) one homepage card's dub stats. */
  async scanHomeCard_(ref) {
    const cached = readCache(homeCacheKey(ref.animeSession), this.cacheTtlMs_);
    if (cached) {
      this.addHomeBadge_(ref.anchor, cached.dubs, cached.total);
      this.itemCompleted_();
      return { cached: true, hasDub: cached.dubs > 0 };
    }
    this.setSpinner_(ref.anchor, true);
    let hasDub = false;
    try {
      const stats = await this.fetchAnimeStats_(ref.animeSession);
      if (stats) {
        writeCache(homeCacheKey(ref.animeSession), stats);
        this.addHomeBadge_(ref.anchor, stats.dubs, stats.total);
        hasDub = stats.dubs > 0;
      }
    } catch {
      // swallow; cache miss + error → no badge
    } finally {
      this.setSpinner_(ref.anchor, false);
    }
    this.itemCompleted_();
    return { cached: false, hasDub };
  }
  /** @return {?Object} The anime's total/dubbed episode counts. */
  async fetchAnimeStats_(animeSession) {
    let data;
    try {
      data = await this.apiFetch_(
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
    const dubs = await this.findDubCountBinary_(animeSession, eps);
    return { dubs, total };
  }
  /** @return {number} How many leading items in `eps` are dubbed. */
  async findBoundaryConcurrent_(animeSession, eps, sessionExtractor) {
    if (!eps.length) return 0;
    const check = (idx) =>
      this.isEpisodeDubbed_(animeSession, sessionExtractor(eps[idx]));
    if (eps.length === 1) return (await check(0)) ? 1 : 0;
    const reqsBeforeInitial = this.reqCompleted_;
    const [firstDubbed, lastDubbed] = await Promise.all([
      check(0),
      check(eps.length - 1),
    ]);
    const initialWasCached = this.reqCompleted_ === reqsBeforeInitial;
    if (!firstDubbed) return 0;
    if (lastDubbed) return eps.length;
    if (!initialWasCached) {
      await this.delay_(this.batchDelay_);
    }
    // Dubs are almost always a contiguous run starting at the oldest
    // episode, with only the most recent handful still sub-only, so gallop
    // backward from the newest episode -- one request at a time, never in
    // parallel -- to find that cutoff quickly without bursting the API.
    const searchId = ++this.searchIdCounter_;
    let notDubbedIdx = eps.length - 1;
    let dubbedIdx = 0;
    let step = 1;
    this.activeSearches_.set(searchId, notDubbedIdx - dubbedIdx);
    this.tickEta_();
    let cursor = notDubbedIdx - step;
    while (cursor > dubbedIdx) {
      if (await check(cursor)) {
        dubbedIdx = cursor;
        break;
      }
      notDubbedIdx = cursor;
      step *= 2;
      cursor = notDubbedIdx - step;
      this.activeSearches_.set(searchId, notDubbedIdx - dubbedIdx);
      this.tickEta_();
    }
    // Binary search narrows the now-small remaining bracket to the exact
    // split, still one request at a time.
    let left = dubbedIdx;
    let right = notDubbedIdx;
    while (right - left > 1) {
      const mid = Math.floor((left + right) / 2);
      if (await check(mid)) left = mid;
      else right = mid;
      this.activeSearches_.set(searchId, right - left);
      this.tickEta_();
    }
    this.activeSearches_.delete(searchId);
    this.tickEta_();
    return left + 1;
  }
  /** @return {number} How many of an anime's episodes are dubbed. */
  async findDubCountBinary_(animeSession, eps) {
    return this.findBoundaryConcurrent_(animeSession, eps, (ep) => {
      const e = ep;
      return e.session || e.anime_session || "";
    });
  }
  /** Adds a DUB badge to an episode-list card. */
  addEpBadge_(el) {
    if (el.querySelector(".ape-dub-badge-ep")) return;
    const badge = document.createElement("span");
    badge.className = "ape-dub-badge ape-dub-badge-ep";
    badge.textContent = "DUB";
    if (getComputedStyle(el).position === "static") {
      el.style.setProperty("position", "relative", "important");
    }
    el.appendChild(badge);
  }
  /** Adds a SUB ONLY badge to an episode-list card. */
  addSubEpBadge_(el) {
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
  /** Adds a dub-count or SUB ONLY badge to a homepage card. */
  addHomeBadge_(el, dubs, total) {
    if (el.querySelector(".ape-dub-badge-home")) return;
    if (dubs <= 0 && !this.settings_.showSubOnlyBadges) return;
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
  /** Shows or hides the loading spinner on a card. */
  setSpinner_(el, on) {
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
  /** Fetches `url` through the throttler and tracks ETA progress. */
  async apiFetch_(url, wantJson = true) {
    const result = await throttler.fetch(url, wantJson);
    this.reqCompleted_++;
    this.tickEta_();
    return result;
  }
  /** @return {boolean} Whether an episode is dubbed, using the cache. */
  async isEpisodeDubbed_(animeSession, epSession) {
    const cached = readCache(epCacheKey(epSession), this.cacheTtlMs_);
    if (cached !== null) return cached;
    if (this.inFlight_.has(epSession)) {
      return this.inFlight_.get(epSession);
    }
    const promise = this.fetchDubStatus_(animeSession, epSession);
    this.inFlight_.set(epSession, promise);
    try {
      return await promise;
    } finally {
      this.inFlight_.delete(epSession);
    }
  }
  /** @return {boolean} An episode's dub status, checking API then HTML. */
  async fetchDubStatus_(animeSession, epSession) {
    let dubbed = null;
    let apiError = null;
    try {
      dubbed = await this.checkDubViaApi_(animeSession, epSession);
    } catch (err) {
      // eslint-disable-next-line no-unused-vars
      apiError = err;
      const e = err;
      if (e.rateLimited) return false;
    }
    if (dubbed === null) {
      try {
        dubbed = await this.checkDubViaHtml_(animeSession, epSession);
      } catch {
        return false;
      }
    }
    writeCache(epCacheKey(epSession), dubbed);
    return dubbed;
  }
  /** @return {boolean} Whether the links API response signals a dub. */
  async checkDubViaApi_(animeSession, epSession) {
    const data = await this.apiFetch_(
      `/api?m=links&id=${animeSession}&session=${epSession}&p=kwik`,
      true,
    );
    return jsonSignalsDub(data);
  }
  /** @return {boolean} Whether the rendered episode page signals a dub. */
  async checkDubViaHtml_(animeSession, epSession) {
    const html = await this.apiFetch_(
      `/play/${animeSession}/${epSession}`,
      false,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    return htmlSignalsDub(html, doc);
  }
}
// Bootstrap.
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

/* Settings modal. */
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
  background: linear-gradient(135deg, rgba(232,113,10,0.06) 0%,
    rgba(217,37,88,0.06) 100%);
  border-radius: 12px 12px 0 0;
}
.ape-set-title-box {
  display: flex; flex-direction: column; gap: 2px; min-width: 0;
}
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

.ape-set-toggle-row.disabled { opacity: 0.4; }
.ape-set-toggle-row.disabled .ape-set-toggle-label,
.ape-set-toggle-row.disabled .ape-set-toggle {
  cursor: default;
}
.ape-set-toggle input:disabled + .ape-set-toggle-track {
  cursor: default;
}

.ape-set-cache-row {
  padding: 0 14px; margin-top: 10px;
}
.ape-set-cache-btn {
  width: 100%;
  background: #1a1a34; border: 1px solid rgba(255,255,255,0.08);
  color: #b8b8d0; font-size: 11.5px; font-weight: 600;
  padding: 8px 10px; border-radius: 6px;
  cursor: pointer;
  transition: background 0.18s, color 0.18s, border-color 0.18s;
}
.ape-set-cache-btn:hover {
  background: rgba(217,37,88,0.18); color: #fff;
  border-color: rgba(217,37,88,0.4);
}

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
  registerMenu("📊 Show cache stats", () => {
    const ep = storage.keysWithPrefix(EP_PREFIX).length;
    const home = storage.keysWithPrefix(HOME_PREFIX).length;
    pill.show(
      `🎙 DUB cache: ${ep} ep · ${home} home · TTL ${CACHE_TTL_HOURS}h`,
      4500,
    );
  });
  // Background GC
  setTimeout(() => {
    const removed = gcDubCache(CACHE_TTL_MS);
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
    version: "2.2.0",
    openSettings: () => panel.open(),
    clearCache: () => clearDubCache(),
    getSettings: () => storage.getSettings(),
  };
})();
