// ==UserScript==
// @name         AnimePahe DUB Detector (Optimized)
// @namespace    https://github.com/abdullahkhfb/animepahe-dub-detector
// @version      2.0
// @description  Tags dubbed episodes with DUB badges on AnimePahe.
// @author       abdullahkhfb
// @license      GPLv3
// @match        *://animepahe.pw/*
// @match        *://animepahe.com/*
// @match        *://animepahe.org/*
// @match        *://animepahe.ru/*
// @updateURL    https://raw.githubusercontent.com/abdullahkhfb/animepahe-dub-detector/main/animepahe-dub.user.js
// @downloadURL  https://raw.githubusercontent.com/abdullahkhfb/animepahe-dub-detector/main/animepahe-dub.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(async function () {
  "use strict";

  const CACHE_TTL = 12 * 60 * 60 * 1000;
  const BATCH_SIZE = 3;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const LOG = (...a) => console.log("[DUB]", ...a);
  const WARN = (...a) => console.warn("[DUB]", ...a);

  // ── Status pill ────────────────────────────────────────────────────────────
  const pill = (() => {
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;bottom:12px;right:12px;z-index:99999;" +
      "background:rgba(0,0,0,.78);color:#fff;font:700 11px/1.5 monospace;" +
      "padding:5px 10px;border-radius:20px;pointer-events:none;" +
      "transition:opacity .5s;max-width:280px;text-align:right;";
    document.body.appendChild(el);
    return {
      set(t) {
        el.textContent = "🎙 DUB: " + t;
        el.style.opacity = "1";
      },
      hide() {
        el.style.opacity = "0";
      },
    };
  })();

  // ── Cache ──────────────────────────────────────────────────────────────────
  function cacheGet(key) {
    try {
      const raw = GM_getValue(key, null);
      if (!raw) return undefined;
      const { ts, val } = JSON.parse(raw);
      if (Date.now() - ts > CACHE_TTL) {
        GM_setValue(key, "");
        return undefined;
      }
      return val;
    } catch {
      return undefined;
    }
  }
  function cacheSet(key, val) {
    GM_setValue(key, JSON.stringify({ ts: Date.now(), val }));
  }

  // ── Throttled Native Fetch ──────────────────────────────────────────────────
  async function apiFetch(url, expectJson = true) {
    await sleep(150); // Optimization: Prevent rapid-fire 429 Too Many Requests
    const resp = await fetch(url, {
      credentials: "include",
      headers: {
        Accept: expectJson ? "application/json" : "text/html,*/*",
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return expectJson ? resp.json() : resp.text();
  }

  // ── Dub detection – method A: /api?m=links ────────────────────────────────
  async function checkViaLinksAPI(animeSession, epSession) {
    const url = `/api?m=links&id=${animeSession}&session=${epSession}&p=kwik`;
    const data = await apiFetch(url);
    const s = JSON.stringify(data).toLowerCase();
    return (
      s.includes('"eng"') || s.includes('"english"') || s.includes('"dub"')
    );
  }

  // ── Dub detection – method B: parse play page HTML ────────────────
  async function checkViaPlayPage(animeSession, epSession) {
    const url = `/play/${animeSession}/${epSession}`;
    const html = await apiFetch(url, false);
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
      if (t.includes("audio") && /['"](eng|english|dub)['"]/i.test(t))
        return true;
    }
    const idx = html.toLowerCase().indexOf('"audio"');
    if (idx !== -1) {
      const snip = html.slice(idx, idx + 32).toLowerCase();
      if (/eng|english|dub/.test(snip)) return true;
    }
    return false;
  }

  // ── Orchestrator with Fast Mode ───────────────────────────────────────────
  async function isEpisodeDubbed(animeSession, epSession, fastMode = false) {
    const cKey = `dub4_${epSession}`;
    const hit = cacheGet(cKey);
    if (hit !== undefined) return hit;

    try {
      const r = await checkViaLinksAPI(animeSession, epSession);
      cacheSet(cKey, r);
      if (r || fastMode) return r;
    } catch (e) {
      WARN("A failed:", e.message);
    }

    if (!fastMode) {
      try {
        const r = await checkViaPlayPage(animeSession, epSession);
        cacheSet(cKey, r);
        return r;
      } catch (e) {
        WARN("B failed:", e.message);
      }
    }
    return false;
  }

  async function findDubCountBinary(animeSession, eps) {
    if (!eps.length) return 0;

    const firstDub = await isEpisodeDubbed(
      animeSession,
      eps[0].session || eps[0].anime_session,
      true,
    );
    if (!firstDub) return 0;

    const lastDub = await isEpisodeDubbed(
      animeSession,
      eps[eps.length - 1].session || eps[eps.length - 1].anime_session,
      true,
    );
    if (lastDub) return eps.length;

    let low = 0;
    let high = eps.length - 1;
    let highestDubIndex = 0;

    while (low <= high) {
      let mid = Math.floor((low + high) / 2);
      const isDub = await isEpisodeDubbed(
        animeSession,
        eps[mid].session || eps[mid].anime_session,
        true,
      );
      if (isDub) {
        highestDubIndex = mid;
        low = mid + 1;
        high = mid - 1;
      }
    }
    return highestDubIndex + 1;
  }

  // ── CSS for badge + spinner ────────────────────────────────────────────────
  document.head.insertAdjacentHTML(
    "beforeend",
    `<style>
    @keyframes dub-spin{to{transform:rotate(360deg)}}
    .dub-badge, .dub-badge-home {
      position: absolute !important; top: 5px !important; bottom: auto !important; z-index: 9999 !important;
      color: #ffffff !important; font-family: sans-serif !important; font-size: 11px !important; font-weight: 700 !important;
      line-height: 1 !important; padding: 3px 7px !important; border-radius: 3px !important;
      letter-spacing: .4px !important; pointer-events: none !important; box-shadow: 0 1px 3px rgba(0,0,0,.55) !important;
      display: inline-block !important; text-indent: 0 !important;
    }
    .dub-badge { background: #e8710a !important; right: 5px !important; left: auto !important; }
    .dub-badge-home { background: #d92558 !important; right: 5px !important; left: auto !important; }
    .dub-spin {
      position: absolute !important; top: 6px !important; bottom: auto !important; z-index: 9999 !important;
      width: 10px !important; height: 10px !important; border-radius: 50% !important;
      pointer-events: none !important; border: 2px solid rgba(255,255,255,.3) !important;
      border-top-color: #fff !important; animation: dub-spin .7s linear infinite !important;
    }
    .dub-spin-anime { right: 6px !important; left: auto !important; }
    .dub-spin-home { right: 6px !important; left: auto !important; }
  </style>`,
  );

  function addBadge(anchor) {
    if (anchor.querySelector(".dub-badge")) return;
    const b = document.createElement("span");
    b.className = "dub-badge";
    b.textContent = "DUB";
    anchor.appendChild(b);
  }

  function addHomeBadge(anchor, text) {
    if (anchor.querySelector(".dub-badge-home")) return;
    const b = document.createElement("span");
    b.className = "dub-badge-home";
    b.textContent = text;
    anchor.appendChild(b);
  }

  function spin(anchor, on, type) {
    if (on) {
      if (anchor.querySelector(".dub-spin")) return;
      const s = document.createElement("span");
      s.className = `dub-spin dub-spin-${type}`;
      anchor.appendChild(s);
    } else {
      anchor.querySelector(".dub-spin")?.remove();
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  ROUTING
  // ════════════════════════════════════════════════════════════════════════════
  const path = location.pathname;

  // ── /anime/{session} ──────────────────────────────────────────────────────
  const animeM = path.match(/^\/anime\/([^/?#]+)/);
  if (animeM) {
    const animeSession = animeM[1];
    let isAnimeScanning = false;

    async function scanAnimeCards() {
      if (isAnimeScanning) return;
      isAnimeScanning = true;

      let list = Array.from(
        document.querySelectorAll(`a[href*="/play/${animeSession}/"]`),
      );
      if (!list.length) {
        list = Array.from(
          document.querySelectorAll('a[href*="/play/"]'),
        ).filter((a) =>
          /\/play\/[^/]+\/[^/]+/.test(a.getAttribute("href") || ""),
        );
      }

      const work = [];
      for (const anchor of list) {
        if (anchor.dataset.dubScanned) continue;
        const m = (anchor.getAttribute("href") || "").match(
          /\/play\/[^/]+\/([^/?#]+)/,
        );
        if (m) {
          anchor.dataset.dubScanned = "true";
          work.push({ anchor, epSession: m[1] });
        }
      }

      if (work.length > 0) {
        pill.set("scanning page…");
        let dubbed = 0;

        for (let i = 0; i < work.length; i += BATCH_SIZE) {
          const wave = work.slice(i, i + BATCH_SIZE);
          pill.set(
            `${i + 1}–${Math.min(i + BATCH_SIZE, work.length)} / ${work.length}`,
          );

          await Promise.all(
            wave.map(async ({ anchor, epSession }) => {
              spin(anchor, true, "anime");
              try {
                const ok = await isEpisodeDubbed(
                  animeSession,
                  epSession,
                  false,
                ); // Allow heavy check here
                spin(anchor, false, "anime");
                if (ok) {
                  if (getComputedStyle(anchor).position === "static") {
                    anchor.style.setProperty(
                      "position",
                      "relative",
                      "important",
                    );
                  }
                  addBadge(anchor);
                  dubbed++;
                }
              } catch (e) {
                spin(anchor, false, "anime");
                WARN(epSession, e.message);
              }
            }),
          );
        }
        pill.set("done");
        setTimeout(() => pill.hide(), 4000);
      }
      isAnimeScanning = false;
    }

    scanAnimeCards();
    const animeObserver = new MutationObserver(() => {
      if (!isAnimeScanning) {
        clearTimeout(window.dubAnimeTimeout);
        window.dubAnimeTimeout = setTimeout(scanAnimeCards, 500);
      }
    });
    animeObserver.observe(document.body, { childList: true, subtree: true });
    return;
  }

  // ── /play/{animeSession}/{epSession} ──────────────────────────────────────
  const playM = path.match(/^\/play\/([^/?#]+)\/([^/?#]+)/);
  if (playM) {
    const [, animeSession, epSession] = playM;
    pill.set("checking…");
    const ok = await isEpisodeDubbed(animeSession, epSession, false);
    if (ok) {
      const titleEl = document.querySelector("h1");
      if (titleEl) {
        const b = document.createElement("span");
        b.textContent = "DUB";
        b.style.cssText =
          "background:#e8710a !important;color:#fff !important;font:700 13px sans-serif !important;padding:4px 8px !important;border-radius:3px !important;margin-left:12px !important;vertical-align:middle !important;display:inline-block !important;box-shadow:0 1px 3px rgba(0,0,0,.55) !important;letter-spacing:.4px !important;";
        titleEl.appendChild(b);
      }
      pill.set("DUB ✓");
    } else {
      pill.set("no dub");
    }
    setTimeout(() => pill.hide(), 4000);
    return;
  }

  // ── Home / latest releases ─────────────────────────────────────────────────
  if (/^\/?$|^\/home/.test(path)) {
    let isScanning = false;

    async function scanHomeCards() {
      if (isScanning) return;
      isScanning = true;

      const work = [];
      for (const a of document.querySelectorAll('a[href*="/anime/"]')) {
        if (a.dataset.dubScanned) continue;
        const m = (a.getAttribute("href") || "").match(/\/anime\/([^/?#]+)/);
        if (!m) continue;
        a.dataset.dubScanned = "true";

        let targetElement = a;
        let parent = a.parentElement;
        while (parent && parent !== document.body) {
          const img = parent.querySelector("img");
          if (img) {
            targetElement = img.closest("a") || img.parentElement;
            targetElement.style.setProperty(
              "position",
              "relative",
              "important",
            );
            targetElement.style.setProperty("display", "block", "important");
            break;
          }
          parent = parent.parentElement;
        }
        work.push({ anchor: targetElement, animeSession: m[1] });
      }

      if (work.length > 0) {
        pill.set("scanning home…");
        for (let i = 0; i < work.length; i += BATCH_SIZE) {
          await Promise.all(
            work
              .slice(i, i + BATCH_SIZE)
              .map(async ({ anchor, animeSession }) => {
                spin(anchor, true, "home");
                const hk = `home7_${animeSession}`; // Bumped cache key for new version
                let stats = cacheGet(hk);

                if (stats === undefined) {
                  try {
                    const rel = await apiFetch(
                      `/api?m=release&id=${animeSession}&sort=episode_asc&page=1`,
                    );
                    const eps = Array.isArray(rel.data)
                      ? rel.data
                      : Object.values(rel.data || {});

                    const totalCount = rel.total || eps.length;

                    // USE BINARY SEARCH OPTIMIZATION
                    const dubCount = await findDubCountBinary(
                      animeSession,
                      eps,
                    );

                    stats = { dubCount, totalCount };
                    cacheSet(hk, stats);
                  } catch (e) {
                    WARN("home error:", animeSession, e.message);
                    spin(anchor, false, "home");
                    return;
                  }
                }

                spin(anchor, false, "home");
                if (stats && stats.dubCount > 0) {
                  addHomeBadge(anchor, `${stats.dubCount}/${stats.totalCount}`);
                }
              }),
          );
        }
        pill.set("done");
        setTimeout(() => pill.hide(), 4000);
      }
      isScanning = false;
    }

    await scanHomeCards();
    const homeObserver = new MutationObserver(() => {
      if (!isScanning) {
        clearTimeout(window.dubHomeTimeout);
        window.dubHomeTimeout = setTimeout(scanHomeCards, 500);
      }
    });
    homeObserver.observe(document.body, { childList: true, subtree: true });
  } else {
    pill.hide();
  }
})();
