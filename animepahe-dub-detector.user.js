// ==UserScript==
// @name         animepahe-DUB-Detector
// @namespace    https://github.com/abdullahkhfb/animepahe-dub-detector
// @version      3.0.0
// @description  Tags dubbed episodes with DUB badges on animepahe.
// @license      GPLv3
// @icon         https://raw.githubusercontent.com/abdullahkhfb/animepahe-dub-detector/main/icon/animepahe-dub-detector.svg
// @match        *://animepahe.pw/*
// @match        *://animepahe.org/*
// @match        *://animepahe.ru/*
// @downloadURL  https://update.greasyfork.org/scripts/577043/animepahe-DUB-Detector.user.js
// @updateURL    https://update.greasyfork.org/scripts/577043/animepahe-DUB-Detector.meta.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(async function () {
  "use strict";

  const CACHE_TTL = 24 * 60 * 60 * 1000;
  const EP_PREFIX = "d2_";
  const HOME_PREFIX = "h2_";
  const PARALLEL_PROBES = 8;

  function cacheGet(key) {
    try {
      const raw = GM_getValue(key, null);
      if (!raw || typeof raw !== "string") return null;
      const pipe = raw.indexOf("|");
      if (pipe === -1) return null;
      const ts = Number(raw.slice(0, pipe));
      if (!Number.isFinite(ts) || Date.now() - ts > CACHE_TTL) {
        GM_deleteValue(key);
        return null;
      }
      return JSON.parse(raw.slice(pipe + 1));
    } catch {
      return null;
    }
  }

  function cacheSet(key, value) {
    GM_setValue(key, `${Date.now()}|${JSON.stringify(value)}`);
  }

  function gcCache() {
    const now = Date.now();
    let removed = 0;
    for (const key of GM_listValues()) {
      if (!key.startsWith(EP_PREFIX) && !key.startsWith(HOME_PREFIX)) continue;
      try {
        const raw = GM_getValue(key, null);
        if (!raw) {
          GM_deleteValue(key);
          removed++;
          continue;
        }
        const pipe = raw.indexOf("|");
        const ts = pipe === -1 ? 0 : Number(raw.slice(0, pipe));
        if (!ts || now - ts > CACHE_TTL) {
          GM_deleteValue(key);
          removed++;
        }
      } catch {
        GM_deleteValue(key);
        removed++;
      }
    }
    if (removed > 0) console.log(`[DUB] GC removed ${removed} stale entries.`);
  }

  function clearAllCache() {
    let removed = 0;
    for (const key of GM_listValues()) {
      if (
        key.startsWith(EP_PREFIX) ||
        key.startsWith(HOME_PREFIX) ||
        key.startsWith("d_") ||
        key.startsWith("h_") ||
        key.startsWith("dub") ||
        key.startsWith("home")
      ) {
        GM_deleteValue(key);
        removed++;
      }
    }
    return removed;
  }

  setTimeout(gcCache, 2000);

  const throttler = (() => {
    const MIN_INTERVAL = 280;
    const JITTER = 80;
    const MAX_CONCURRENT = 4;
    const MAX_RETRIES = 3;
    const BASE_BACKOFF = 2000;

    const queue = [];
    let active = 0;
    let lastLaunch = 0;
    let backoffUntil = 0;
    let draining = false;

    const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

    async function attempt(url, wantJson) {
      const res = await fetch(url, {
        credentials: "include",
        headers: {
          Accept: wantJson ? "application/json" : "text/html,*/*",
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      if (res.status === 429 || res.status === 503 || res.status === 403) {
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          rateLimited: true,
        });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (wantJson) {
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("json")) {
          const text = await res.text();
          if (/rate.?limit|error\s+1015|cloudflare/i.test(text)) {
            throw Object.assign(new Error("Rate-limited (HTML response)"), {
              rateLimited: true,
            });
          }
          throw new Error(`Expected JSON, got: ${ct}`);
        }
        return res.json();
      }
      return res.text();
    }

    async function execute(task) {
      try {
        task.resolve(await attempt(task.url, task.wantJson));
      } catch (err) {
        if (err.rateLimited && task.retries < MAX_RETRIES) {
          backoffUntil = Date.now() + BASE_BACKOFF * Math.pow(2, task.retries);
          task.retries++;
          queue.unshift(task);
        } else {
          task.reject(err);
        }
      } finally {
        active--;
        if (!draining && (queue.length > 0 || active > 0)) drain();
      }
    }

    async function drain() {
      draining = true;
      while (queue.length > 0 || active > 0) {
        const backoffLeft = backoffUntil - Date.now();
        if (backoffLeft > 0) {
          await sleep(backoffLeft);
          continue;
        }
        if (queue.length > 0 && active < MAX_CONCURRENT) {
          const jitter = Math.floor(Math.random() * JITTER * 2) - JITTER;
          const gap = MIN_INTERVAL + jitter;
          const since = Date.now() - lastLaunch;
          if (since < gap) {
            await sleep(gap - since);
            continue;
          }
          const task = queue.shift();
          active++;
          lastLaunch = Date.now();
          execute(task);
          continue;
        }
        await sleep(30);
      }
      draining = false;
    }

    return {
      fetch(url, wantJson = true) {
        return new Promise((resolve, reject) => {
          queue.push({ url, wantJson, resolve, reject, retries: 0 });
          if (!draining) drain();
        });
      },
      get pendingCount() {
        return queue.length + active;
      },
    };
  })();

  const pill = (() => {
    const el = document.createElement("div");
    el.id = "ape-dub-pill";
    Object.assign(el.style, {
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
    document.body.appendChild(el);

    let timer = null;

    return {
      show(text, autohideMs = 0, live = false) {
        if (!live) clearTimeout(timer);
        el.textContent = text;
        el.style.opacity = "1";
        if (autohideMs > 0)
          timer = setTimeout(() => (el.style.opacity = "0"), autohideMs);
      },
      hide() {
        clearTimeout(timer);
        el.style.opacity = "0";
      },
    };
  })();

  if (typeof GM_registerMenuCommand !== "undefined") {
    GM_registerMenuCommand("🗑️ Clear Dub Detector Cache", () => {
      const n = clearAllCache();
      pill.show(`🎙 DUB: Cleared ${n} items`, 0);
      setTimeout(() => location.reload(), 1000);
    });
  }

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style>
    @keyframes ape-dub-spin { to { transform: rotate(360deg); } }
    .ape-dub-badge {
      position: absolute !important; top: 5px !important; right: 5px !important;
      z-index: 9999 !important; color: #fff !important;
      font: 700 11px/1 system-ui,sans-serif !important;
      padding: 3px 7px !important; border-radius: 3px !important;
      letter-spacing: .4px !important; pointer-events: none !important;
      box-shadow: 0 1px 3px rgba(0,0,0,.55) !important;
      display: inline-flex !important; align-items: center !important;
      gap: 3px !important; text-indent: 0 !important;
    }
    .ape-dub-badge-ep   { background: #d92558 !important; }
    .ape-dub-badge-home { background: #d92558 !important; }
    .ape-dub-inline {
      background: #e8710a; color: #fff;
      font: 700 11px system-ui,sans-serif;
      padding: 3px 9px; border-radius: 3px;
      margin-left: 10px; vertical-align: middle;
      display: inline-block;
      box-shadow: 0 1px 5px rgba(0,0,0,.5);
      letter-spacing: .5px;
    }
    .ape-dub-spin {
      position: absolute !important; top: 6px !important; right: 6px !important;
      z-index: 9999 !important; width: 10px !important; height: 10px !important;
      border-radius: 50% !important; pointer-events: none !important;
      border: 2px solid rgba(255,255,255,.3) !important;
      border-top-color: #fff !important;
      animation: ape-dub-spin .7s linear infinite !important;
    }
  </style>`,
  );

  let etaInterval = null;
  let scanStart = 0;
  let reqCompleted = 0;
  let lastPct = 0;
  let pillBaseText = "";
  const activeSearches = new Map();
  let searchIdCounter = 0;

  function startEta(baseText) {
    stopEta();
    scanStart = Date.now();
    reqCompleted = 0;
    lastPct = 0;
    pillBaseText = baseText;
    tickEta();
    etaInterval = setInterval(tickEta, 50);
  }

  function stopEta() {
    if (etaInterval) {
      clearInterval(etaInterval);
      etaInterval = null;
    }
  }

  function tickEta() {
    let searchPending = 0;
    for (const size of activeSearches.values()) {
      if (size > 1) {
        searchPending +=
          Math.ceil(Math.log(size) / Math.log(PARALLEL_PROBES)) *
          (PARALLEL_PROBES - 1);
      }
    }

    const pending = throttler.pendingCount + searchPending;
    const currentTotal = reqCompleted + pending;
    let pctStr = "";

    if (currentTotal > 0) {
      let rawPct = Math.floor((reqCompleted / currentTotal) * 100);
      lastPct = Math.max(lastPct, rawPct);
      let pct = pending === 0 && reqCompleted > 0 ? 100 : Math.min(99, lastPct);
      pctStr = `  ·  ${pct}%`;
    }
    pill.show(`${pillBaseText}${pctStr}`, 0, true);
  }

  async function apiFetch(url, wantJson = true) {
    const result = await throttler.fetch(url, wantJson);
    reqCompleted++;
    tickEta();
    return result;
  }

  async function checkDubViaApi(animeSession, epSession) {
    const data = await apiFetch(
      `/api?m=links&id=${animeSession}&session=${epSession}&p=kwik`,
    );
    const s = JSON.stringify(data).toLowerCase();
    return (
      s.includes('"eng"') || s.includes('"english"') || s.includes('"dub"')
    );
  }

  async function checkDubViaHtml(animeSession, epSession) {
    const html = await apiFetch(`/play/${animeSession}/${epSession}`, false);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const area =
      doc.getElementById("pickDownload") || doc.getElementById("scrollArea");
    if (area) {
      const txt = area.textContent;
      if (/\bEng\b/i.test(txt) || /english/i.test(txt) || /\bdub\b/i.test(txt))
        return true;
    }
    for (const s of doc.querySelectorAll("script:not([src])")) {
      const t = s.textContent || "";
      if (t.includes("audio") && /['\"](eng|english|dub)['\"]/.test(t))
        return true;
    }
    const idx = html.toLowerCase().indexOf('"audio"');
    if (
      idx !== -1 &&
      /eng|english|dub/.test(html.slice(idx, idx + 32).toLowerCase())
    )
      return true;
    return false;
  }

  async function isEpisodeDubbed(animeSession, epSession) {
    const cKey = `${EP_PREFIX}${epSession}`;
    const hit = cacheGet(cKey);
    if (hit !== null) return hit;

    let dubbed = false;
    try {
      dubbed = await checkDubViaApi(animeSession, epSession);
    } catch {
      try {
        dubbed = await checkDubViaHtml(animeSession, epSession);
      } catch {}
    }

    cacheSet(cKey, dubbed);
    return dubbed;
  }

  async function findBoundaryConcurrent(animeSession, eps, sessionOf) {
    if (!eps.length) return 0;

    const check = (i) => isEpisodeDubbed(animeSession, sessionOf(eps[i]));

    if (eps.length === 1) return (await check(0)) ? 1 : 0;

    const [firstDubbed, lastDubbed] = await Promise.all([
      check(0),
      check(eps.length - 1),
    ]);
    if (!firstDubbed) return 0;
    if (lastDubbed) return eps.length;

    const searchId = ++searchIdCounter;
    let left = 0;
    let right = eps.length - 1;

    while (left < right - 1) {
      activeSearches.set(searchId, right - left);
      tickEta();

      const step = (right - left) / PARALLEL_PROBES;
      const probeIdxs = [];
      for (let i = 1; i < PARALLEL_PROBES; i++) {
        const mid = Math.floor(left + step * i);
        if (mid > left && mid < right && !probeIdxs.includes(mid))
          probeIdxs.push(mid);
      }
      if (!probeIdxs.length) break;

      const results = await Promise.all(probeIdxs.map(check));
      let lastTrue = -1;
      for (let i = 0; i < results.length; i++) {
        if (results[i]) lastTrue = i;
        else break;
      }
      if (lastTrue === -1) {
        right = probeIdxs[0];
      } else if (lastTrue === probeIdxs.length - 1) {
        left = probeIdxs[lastTrue];
      } else {
        left = probeIdxs[lastTrue];
        right = probeIdxs[lastTrue + 1];
      }
    }

    activeSearches.delete(searchId);
    tickEta();
    return left + 1;
  }

  function ensureRelative(el) {
    if (getComputedStyle(el).position === "static")
      el.style.setProperty("position", "relative", "important");
  }

  function addEpBadge(el) {
    if (el.querySelector(".ape-dub-badge-ep")) return;
    ensureRelative(el);
    const b = document.createElement("span");
    b.className = "ape-dub-badge ape-dub-badge-ep";
    b.textContent = "DUB";
    el.appendChild(b);
  }

  function addHomeBadge(el, dubs, total) {
    if (!dubs || el.querySelector(".ape-dub-badge-home")) return;
    ensureRelative(el);
    const b = document.createElement("span");
    b.className = "ape-dub-badge ape-dub-badge-home";
    b.textContent = `🎙 ${dubs}/${total}`;
    el.appendChild(b);
  }

  function setSpinner(el, on) {
    if (on) {
      if (el.querySelector(".ape-dub-spin")) return;
      ensureRelative(el);
      const s = document.createElement("span");
      s.className = "ape-dub-spin";
      el.appendChild(s);
    } else {
      el.querySelector(".ape-dub-spin")?.remove();
    }
  }

  function getThumbnailTarget(anchor) {
    let img = anchor.querySelector("img");
    if (img) return anchor;
    let p = anchor.parentElement;
    for (let d = 0; p && d < 4; d++) {
      img = p.querySelector("img");
      if (img) break;
      p = p.parentElement;
    }
    if (img) return img.closest("a") || img.parentElement;
    return anchor;
  }

  const SEARCH_EXCLUDE =
    ".ui-autocomplete, .search-results, header, .top-header, form, #search, .autocomplete, .dropdown";

  async function scanEpisodeList(animeSession) {
    const cards = [...document.querySelectorAll('a[href*="/play/"]')].filter(
      (a) => !a.closest(SEARCH_EXCLUDE),
    );

    const episodes = [];
    const seen = new Set();

    for (const a of cards) {
      const m = (a.getAttribute("href") || "").match(
        /\/play\/[^/]+\/([^/?#]+)/,
      );
      if (!m) continue;
      const epSession = m[1];
      const target = getThumbnailTarget(a);
      if (target.dataset.apeDubDone) continue;
      target.dataset.apeDubDone = "1";
      if (!seen.has(epSession)) {
        seen.add(epSession);
        episodes.push({ el: target, epSession });
      }
    }

    if (!episodes.length) return;

    episodes.reverse();
    startEta("🎙 DUB: Scanning");

    const count = await findBoundaryConcurrent(
      animeSession,
      episodes,
      (ep) => ep.epSession,
    );
    for (let i = 0; i < count; i++) addEpBadge(episodes[i].el);

    stopEta();
    pill.show(
      count > 0
        ? `🎙 DUB: ${count} episode${count === 1 ? "" : "s"} dubbed ✓`
        : "🎙 DUB: no dub found",
      4500,
    );
  }

  async function initPlayer(animeSession, epSession) {
    document.querySelector(".ape-dub-inline")?.remove();
    startEta("🎙 DUB: Checking");
    const dubbed = await isEpisodeDubbed(animeSession, epSession);
    stopEta();
    if (dubbed) {
      const h1 = document.querySelector("h1");
      if (h1 && !h1.querySelector(".ape-dub-inline")) {
        const b = document.createElement("span");
        b.className = "ape-dub-inline";
        b.textContent = "DUB";
        h1.appendChild(b);
      }
      pill.show("🎙 DUB: Dubbed ✓", 5000);
    } else {
      pill.show("🎙 DUB: Sub only", 4000);
    }
  }

  async function scanHomeCards() {
    const cards = [
      ...document.querySelectorAll('a[href*="/anime/"], a[href*="/play/"]'),
    ].filter((a) => !a.closest(SEARCH_EXCLUDE));

    const work = [];
    const seen = new Set();

    for (const a of cards) {
      const m = (a.getAttribute("href") || "").match(
        /(?:\/anime\/|\/play\/)([^/?#]+)/,
      );
      if (!m) continue;
      const animeSession = m[1];
      const target = getThumbnailTarget(a);
      if (target.dataset.apeDubDone) continue;
      if (!target.querySelector("img")) continue;
      target.dataset.apeDubDone = "1";
      if (!seen.has(animeSession)) {
        seen.add(animeSession);
        work.push({ anchor: target, animeSession });
      }
    }

    if (!work.length) return;

    startEta("🎙 DUB: Scanning home");

    await Promise.all(
      work.map(async ({ anchor, animeSession }) => {
        const cKey = `${HOME_PREFIX}${animeSession}`;
        let stats = cacheGet(cKey);

        if (stats === null) {
          setSpinner(anchor, true);
          try {
            const rel = await apiFetch(
              `/api?m=release&id=${animeSession}&sort=episode_asc&page=1`,
            );
            const eps = Array.isArray(rel.data)
              ? rel.data
              : Object.values(rel.data || {});
            const total = rel.total ?? eps.length;
            const dubs = await findBoundaryConcurrent(
              animeSession,
              eps,
              (ep) => ep.session || ep.anime_session,
            );
            stats = { dubs, total };
            cacheSet(cKey, stats);
          } catch (e) {
            console.warn("[DUB] home card error:", animeSession, e.message);
          } finally {
            setSpinner(anchor, false);
          }
        }

        if (stats?.dubs > 0) addHomeBadge(anchor, stats.dubs, stats.total);
      }),
    );

    stopEta();
    pill.show("🎙 DUB: scan complete ✓", 4000);
  }

  function makeDebounced(fn, ms = 100) {
    let t = null;
    return () => {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  async function handleRoute() {
    const path = location.pathname;

    const playerM = path.match(/^\/play\/([^/?#]+)\/([^/?#]+)/);
    if (playerM) {
      await initPlayer(playerM[1], playerM[2]);
      return;
    }

    const animeM = path.match(/^\/anime\/([^/?#]+)/);
    if (animeM) {
      const animeSession = animeM[1];
      await scanEpisodeList(animeSession);
      new MutationObserver(
        makeDebounced(() => scanEpisodeList(animeSession)),
      ).observe(document.body, { childList: true, subtree: true });
      return;
    }

    if (/^\/?$|^\/home/.test(path)) {
      let busy = false;
      const runScan = async () => {
        if (busy) return;
        busy = true;
        try {
          await scanHomeCards();
        } finally {
          busy = false;
        }
      };
      await runScan();
      new MutationObserver(
        makeDebounced(() => {
          if (!busy) runScan();
        }),
      ).observe(document.body, { childList: true, subtree: true });
      return;
    }

    pill.hide();
  }

  let currentUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== currentUrl) {
      currentUrl = location.href;
      handleRoute();
    }
  }).observe(document.body, { childList: true, subtree: true });

  await handleRoute();
})();
