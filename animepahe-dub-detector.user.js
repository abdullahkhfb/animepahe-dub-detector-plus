// ==UserScript==
// @name         animepahe-DUB-Detector
// @namespace    https://github.com/abdullahkhfb/animepahe-dub-detector
// @version      2.0.4
// @description  Tags dubbed episodes with DUB badges on animepahe.
// @license      GPLv3
// @icon         https://raw.githubusercontent.com/abdullahkhfb/animepahe-dub-detector/main/icon/animepahe-dub-detector.svg
// @match        *://animepahe.pw/*
// @match        *://animepahe.org/*
// @downloadURL https://update.greasyfork.org/scripts/577043/animepahe-DUB-Detector.user.js
// @updateURL   https://update.greasyfork.org/scripts/577043/animepahe-DUB-Detector.meta.js
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(async function () {
  "use strict";

  const CACHE_TTL = 12 * 60 * 60 * 1000;
  const BATCH_SIZE = 3;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const LOG = (...a) => console.log("[DUB]", ...a);
  const WARN = (...a) => console.warn("[DUB]", ...a);

  const pill = (() => {
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;bottom:12px;right:12px;z-index:99999;" +
      "background:rgba(0,0,0,.85);color:#fff;font:700 11px/1.5 monospace;" +
      "padding:5px 10px;border-radius:20px;pointer-events:none;" +
      "transition:opacity .5s;max-width:340px;text-align:right;" +
      "display:flex;align-items:center;gap:8px;box-shadow:0 2px 8px rgba(0,0,0,0.3);";

    const textSpan = document.createElement("span");
    el.appendChild(textSpan);

    const btn = document.createElement("button");
    btn.textContent = "Clear Cache";
    btn.style.cssText =
      "background:#d92558;color:#fff;border:none;padding:2px 8px;border-radius:12px;" +
      "cursor:pointer;font:700 9px sans-serif;text-transform:uppercase;line-height:1;" +
      "pointer-events:auto;display:none;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:background 0.2s;";

    btn.onmouseenter = () => (btn.style.background = "#b81d47");
    btn.onmouseleave = () => (btn.style.background = "#d92558");

    const clearCacheAction = () => {
      const keys = GM_listValues();
      let deletedCount = 0;
      for (const key of keys) {
        if (
          key.startsWith("d_") ||
          key.startsWith("h_") ||
          key.startsWith("dub") ||
          key.startsWith("home") ||
          key.startsWith("d2_") ||
          key.startsWith("h2_")
        ) {
          GM_deleteValue(key);
          deletedCount++;
        }
      }
      textSpan.textContent = `🎙 DUB: Cleared ${deletedCount} items!`;
      btn.style.display = "none";
      LOG(`Manual cache clear executed. Removed ${deletedCount} items.`);
      setTimeout(() => {
        location.reload();
      }, 1000);
    };

    btn.addEventListener("click", clearCacheAction);
    el.appendChild(btn);
    document.body.appendChild(el);

    return {
      set(t) {
        textSpan.textContent = "🎙 DUB: " + t;
        el.style.opacity = "1";
        el.style.pointerEvents = "auto";
        btn.style.display = "inline-block";
      },
      hide() {
        el.style.opacity = "0";
        el.style.pointerEvents = "none";
        btn.style.display = "none";
      },
      clearCache: clearCacheAction,
    };
  })();

  if (typeof GM_registerMenuCommand !== "undefined") {
    GM_registerMenuCommand("🗑️ Clear Dub Detector Cache", () => {
      pill.clearCache();
    });
  }

  function cleanExpiredCache() {
    const keys = GM_listValues();
    const now = Date.now();
    let deletedCount = 0;

    for (const key of keys) {
      if (
        key.startsWith("d_") ||
        key.startsWith("h_") ||
        key.startsWith("dub") ||
        key.startsWith("home")
      ) {
        GM_deleteValue(key);
        deletedCount++;
        continue;
      }

      if (!key.startsWith("d2_") && !key.startsWith("h2_")) continue;

      try {
        const raw = GM_getValue(key, "");
        let ts = 0;

        if (typeof raw === "string" && raw.includes("|")) {
          ts = parseInt(raw.split("|")[0], 10);
        } else if (typeof raw === "string" && raw.startsWith("{")) {
          ts = JSON.parse(raw).ts;
        }

        if (!ts || now - ts > CACHE_TTL) {
          GM_deleteValue(key);
          deletedCount++;
        }
      } catch (e) {
        GM_deleteValue(key);
        deletedCount++;
      }
    }
    if (deletedCount > 0)
      LOG(`Garbage collector removed ${deletedCount} old/expired items.`);
  }

  setTimeout(cleanExpiredCache, 2000);

  function cacheGet(key) {
    try {
      const raw = GM_getValue(key, null);
      if (!raw) return undefined;

      if (typeof raw === "string" && raw.includes("|")) {
        const parts = raw.split("|");
        const ts = parseInt(parts[0], 10);

        if (Date.now() - ts > CACHE_TTL) {
          GM_deleteValue(key);
          return undefined;
        }
        return JSON.parse(parts.slice(1).join("|"));
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  function cacheSet(key, val) {
    GM_setValue(key, `${Date.now()}|${JSON.stringify(val)}`);
  }

  async function apiFetch(url, expectJson = true) {
    await sleep(150);
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

  async function checkViaLinksAPI(animeSession, epSession) {
    const url = `/api?m=links&id=${animeSession}&session=${epSession}&p=kwik`;
    const data = await apiFetch(url);
    const s = JSON.stringify(data).toLowerCase();
    return (
      s.includes('"eng"') || s.includes('"english"') || s.includes('"dub"')
    );
  }

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

  async function isEpisodeDubbed(animeSession, epSession) {
    const cKey = `d2_${epSession}`;
    const hit = cacheGet(cKey);
    if (hit !== undefined) return hit;

    let r = false;

    try {
      r = await checkViaLinksAPI(animeSession, epSession);
    } catch (e) {
      WARN("A failed:", e.message);
    }

    if (!r) {
      try {
        r = await checkViaPlayPage(animeSession, epSession);
      } catch (e) {
        WARN("B failed:", e.message);
      }
    }

    cacheSet(cKey, r);
    return r;
  }

  async function findDubCountBinary(animeSession, eps) {
    if (!eps.length) return 0;

    const firstDub = await isEpisodeDubbed(
      animeSession,
      eps[0].session || eps[0].anime_session,
    );
    if (!firstDub) return 0;

    const lastDub = await isEpisodeDubbed(
      animeSession,
      eps[eps.length - 1].session || eps[eps.length - 1].anime_session,
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
      );
      if (isDub) {
        highestDubIndex = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return highestDubIndex + 1;
  }

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style>
    @keyframes dub-spin{to{transform:rotate(360deg)}}
    .dub-badge, .dub-badge-home {
      position: absolute !important; top: 5px !important; bottom: auto !important; z-index: 9999 !important;
      color: #ffffff !important; font-family: sans-serif !important; font-size: 11px !important; font-weight: 700 !important;
      line-height: 1 !important; padding: 3px 7px !important; border-radius: 3px !important;
      letter-spacing: .4px !important; pointer-events: none !important; box-shadow: 0 1px 3px rgba(0,0,0,.55) !important;
      display: inline-flex !important; align-items: center !important; gap: 3px !important; text-indent: 0 !important;
    }
    .dub-badge { background: #d92558 !important; right: 5px !important; left: auto !important; }
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
    b.textContent = `🎙 ${text}`;
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

  const path = location.pathname;

  if (/^\/anime\/([^/?#]+)/.test(path)) {
    let isAnimeScanning = false;

    async function scanAnimeCards() {
      if (isAnimeScanning) return;
      isAnimeScanning = true;

      try {
        let list = Array.from(
          document.querySelectorAll('a[href*="/play/"]'),
        ).filter(
          (a) =>
            !a.closest(
              ".search-results, #search, .search, .autocomplete, .dropdown",
            ),
        );

        const work = [];
        for (const anchor of list) {
          if (anchor.dataset.dubScanned) continue;

          const href = anchor.getAttribute("href") || "";
          const m = href.match(/(?:\/play\/)([^/?#]+)\/([^/?#]+)/);
          if (m) {
            anchor.dataset.dubScanned = "true";
            work.push({ anchor, animeUuid: m[1], epUuid: m[2] });
          }
        }

        if (work.length > 0) {
          pill.set("fast scanning…");
          work.reverse();

          let highestDubIndex = -1;

          const firstDub = await isEpisodeDubbed(
            work[0].animeUuid,
            work[0].epUuid,
          );

          if (firstDub) {
            const lastDub = await isEpisodeDubbed(
              work[work.length - 1].animeUuid,
              work[work.length - 1].epUuid,
            );
            if (lastDub) {
              highestDubIndex = work.length - 1;
            } else {
              let low = 0;
              let high = work.length - 1;
              while (low <= high) {
                let mid = Math.floor((low + high) / 2);
                const isDub = await isEpisodeDubbed(
                  work[mid].animeUuid,
                  work[mid].epUuid,
                );
                if (isDub) {
                  highestDubIndex = mid;
                  low = mid + 1;
                } else {
                  high = mid - 1;
                }
              }
            }
          }

          let dubbed = 0;
          for (let i = 0; i <= highestDubIndex; i++) {
            const item = work[i];
            let target = item.anchor;

            let img = target.querySelector("img");
            if (img) {
              target = img.closest("a") || img.parentElement;
            }

            if (getComputedStyle(target).position === "static") {
              target.style.setProperty("position", "relative", "important");
            }
            addBadge(target);
            dubbed++;
          }

          pill.set(`Page: ${dubbed} DUB ✓`);
          setTimeout(() => pill.hide(), 4000);
        }
      } catch (e) {
        console.error("[DUB] scanAnimeCards error:", e);
        pill.set("scan error");
        setTimeout(() => pill.hide(), 4000);
      } finally {
        isAnimeScanning = false;
      }
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

  const playM = path.match(/^\/play\/([^/?#]+)\/([^/?#]+)/);
  if (playM) {
    const [, animeSession, epSession] = playM;
    pill.set("checking…");
    const ok = await isEpisodeDubbed(animeSession, epSession);
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

  if (/^\/?$|^\/home/.test(path)) {
    let isScanning = false;

    async function scanHomeCards() {
      if (isScanning) return;
      isScanning = true;

      try {
        const work = [];
        for (const a of document.querySelectorAll(
          'a[href*="/anime/"], a[href*="/play/"]',
        )) {
          if (a.dataset.dubScanned) continue;
          if (
            a.closest(
              ".search-results, #search, .search, .autocomplete, .dropdown",
            )
          )
            continue;

          const href = a.getAttribute("href") || "";
          const m = href.match(/(?:\/anime\/|\/play\/)([^/?#]+)/);
          if (!m) continue;

          a.dataset.dubScanned = "true";

          let img = a.querySelector("img");
          let targetElement = a;

          if (!img) {
            let parent = a.parentElement;
            let depth = 0;
            while (parent && depth < 3) {
              img = parent.querySelector("img");
              if (img) break;
              parent = parent.parentElement;
              depth++;
            }
          }

          if (!img) continue;

          targetElement = img.closest("a") || img.parentElement;
          if (getComputedStyle(targetElement).position === "static") {
            targetElement.style.setProperty(
              "position",
              "relative",
              "important",
            );
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
                  const hk = `h2_${animeSession}`;
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
                    addHomeBadge(
                      anchor,
                      `${stats.dubCount}/${stats.totalCount}`,
                    );
                  }
                }),
            );
          }
          pill.set("done");
          setTimeout(() => pill.hide(), 4000);
        }
      } catch (e) {
        console.error("[DUB] Home scan error:", e);
        pill.set("scan error");
        setTimeout(() => pill.hide(), 4000);
      } finally {
        isScanning = false;
      }
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
