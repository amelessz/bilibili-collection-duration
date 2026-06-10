// ==UserScript==
// @name         Bilibili 合集总时长
// @namespace    https://github.com/local-userscripts
// @version      0.2.4
// @description  统计 Bilibili 合集/多 P 视频总时长，并显示在分享按钮右侧
// @author       local
// @license      MIT
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/watchlater*
// @run-at       document-idle
// @grant        none
// @downloadURL none
// ==/UserScript==

(function () {
  "use strict";

  const BADGE_ID = "bcd-total-duration-badge";
  const STYLE_ID = "bcd-total-duration-style";
  const LOG_PREFIX = "[Bilibili 合集总时长]";
  const MAX_DOM_SCAN_ITEMS = 1000;

  let lastPageKey = "";
  let refreshTimer = 0;
  let routeTimer = 0;
  let refreshSequence = 0;
  let activeRequest = null;
  let nextRetryAt = 0;
  let lastObservedUrl = location.href;
  let positionFrame = 0;

  function log(...args) {
    console.debug(LOG_PREFIX, ...args);
  }

  function getInitialState() {
    return window.__INITIAL_STATE__ || window.__INITIAL_STATE;
  }

  function getStateBvid(state) {
    const candidates = [
      state?.bvid,
      state?.videoData?.bvid,
      state?.videoData?.ugc_season?.ep_count && state?.videoData?.bvid,
    ];

    return (
      candidates.find(
        (value) => typeof value === "string" && value.startsWith("BV"),
      ) || ""
    );
  }

  function getCurrentBvid() {
    const pathMatch = location.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/);
    if (pathMatch) return pathMatch[1];

    return getStateBvid(getInitialState());
  }

  function normalizeDuration(value) {
    if (value == null || value === "") return 0;

    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;

    // B 站大多数接口返回秒；个别页面状态可能出现毫秒。
    return numeric > 100000 ? Math.round(numeric / 1000) : Math.round(numeric);
  }

  function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.round(totalSeconds));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;

    if (h > 0) {
      return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }

    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function parseDurationText(text) {
    const trimmed = String(text || "").trim();
    if (!/^\d{1,3}:\d{2}(?::\d{2})?$/.test(trimmed)) return 0;

    const parts = trimmed.split(":").map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return 0;

    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }

    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  function sumDurations(items, getDuration) {
    if (!Array.isArray(items) || items.length === 0) {
      return { totalSeconds: 0, count: 0 };
    }

    let totalSeconds = 0;
    let count = 0;

    for (const item of items) {
      const duration = normalizeDuration(getDuration(item));
      if (duration > 0) {
        totalSeconds += duration;
        count += 1;
      }
    }

    return { totalSeconds, count };
  }

  function collectEpisodesFromSeason(season) {
    const sections = Array.isArray(season?.sections) ? season.sections : [];
    const episodes = [];

    for (const section of sections) {
      if (Array.isArray(section?.episodes)) {
        episodes.push(...section.episodes);
      }
    }

    if (episodes.length === 0 && Array.isArray(season?.episodes)) {
      episodes.push(...season.episodes);
    }

    return episodes;
  }

  function collectFromInitialState(currentBvid) {
    const state = getInitialState();
    if (!state) return null;

    const stateBvid = getStateBvid(state);
    if (currentBvid && stateBvid !== currentBvid) {
      return null;
    }

    const seasons = [
      state?.videoData?.ugc_season,
      state?.videoData?.ugcSeason,
      state?.ugc_season,
      state?.ugcSeason,
      state?.season,
    ].filter(Boolean);

    for (const season of seasons) {
      const episodes = collectEpisodesFromSeason(season);
      const result = sumDurations(episodes, (episode) => episode?.duration);
      if (result.count > 1) {
        return { ...result, source: "initial-state:ugc-season" };
      }
    }

    const pageLists = [
      state?.videoData?.pages,
      state?.pages,
      state?.sections?.flatMap?.((section) => section?.episodes || []),
    ].filter(Array.isArray);

    for (const pages of pageLists) {
      const result = sumDurations(pages, (page) => page?.duration);
      if (result.count > 1) {
        return { ...result, source: "initial-state:pages" };
      }
    }

    return null;
  }

  async function collectFromApi(bvid, signal) {
    if (!bvid) return null;

    const response = await fetch(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      {
        credentials: "include",
        signal,
      },
    );

    if (!response.ok) {
      throw new Error(`API HTTP ${response.status}`);
    }

    const payload = await response.json();
    const data = payload?.data;
    if (!data) return null;

    const seasonEpisodes = collectEpisodesFromSeason(data?.ugc_season);
    const seasonResult = sumDurations(
      seasonEpisodes,
      (episode) => episode?.duration,
    );
    if (seasonResult.count > 1) {
      return { ...seasonResult, source: "api:ugc-season" };
    }

    const pageResult = sumDurations(data?.pages, (page) => page?.duration);
    if (pageResult.count > 1) {
      return { ...pageResult, source: "api:pages" };
    }

    return null;
  }

  function collectFromDom() {
    const header = findVideoPodHeader();
    const container =
      header?.closest(".video-pod") ||
      document.querySelector(".video-pod") ||
      header?.parentElement ||
      document;
    const candidates = Array.from(container.querySelectorAll("*")).slice(
      0,
      MAX_DOM_SCAN_ITEMS,
    );
    const durations = [];

    for (const element of candidates) {
      if (element.childElementCount > 0) continue;

      const text = element.textContent?.trim();
      if (!text || text.length > 10) continue;

      const seconds = parseDurationText(text);
      if (seconds > 0) {
        durations.push(seconds);
      }
    }

    if (durations.length <= 1) return null;

    return {
      totalSeconds: durations.reduce((sum, seconds) => sum + seconds, 0),
      count: durations.length,
      source: "dom",
    };
  }

  function findVideoPodHeader() {
    const headers = Array.from(document.querySelectorAll(".video-pod__header"));
    return (
      headers.find((header) => header.textContent?.includes("视频选集")) ||
      headers[0] ||
      null
    );
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${BADGE_ID} {
        position: fixed;
        z-index: 10;
        display: none;
        align-items: center;
        height: 24px;
        padding: 0 8px;
        border-radius: 6px;
        background: rgba(0, 174, 236, 0.1);
        color: #00aeec;
        font-size: 12px;
        line-height: 24px;
        white-space: nowrap;
        user-select: none;
        pointer-events: none;
        transform: translateY(-50%);
      }

      #${BADGE_ID} .bcd-duration-compact {
        display: none;
      }

      #${BADGE_ID}[data-visible="true"] {
        display: inline-flex;
      }

      #${BADGE_ID}[data-layout="compact"] .bcd-duration-full {
        display: none;
      }

      #${BADGE_ID}[data-layout="compact"] .bcd-duration-compact {
        display: inline;
      }
    `;
    document.head.appendChild(style);
  }

  function findShareAnchor() {
    return document
      .querySelector("#arc_toolbar_report .video-share-wrap")
      ?.closest(".toolbar-left-item-wrap");
  }

  function getBadge() {
    return document.getElementById(BADGE_ID);
  }

  function ensureBadge() {
    ensureStyle();

    let badge = getBadge();
    if (!badge) {
      badge = document.createElement("div");
      badge.id = BADGE_ID;
    }

    if (badge.parentElement !== document.body) {
      document.body.appendChild(badge);
    }

    return badge;
  }

  function setBadgeContent(badge, fullText, compactText) {
    badge.replaceChildren();

    const full = document.createElement("span");
    full.className = "bcd-duration-full";
    full.textContent = fullText;

    const compact = document.createElement("span");
    compact.className = "bcd-duration-compact";
    compact.textContent = compactText;

    badge.append(full, compact);
  }

  function updateBadgePosition() {
    const badge = getBadge();
    const anchor = findShareAnchor();
    if (!badge || !anchor) {
      if (badge) badge.dataset.visible = "false";
      return false;
    }

    const anchorRect = anchor.getBoundingClientRect();
    const toolbarRightRect = document
      .querySelector("#arc_toolbar_report .video-toolbar-right")
      ?.getBoundingClientRect();
    const left = anchorRect.right + 18;
    const rightLimit = toolbarRightRect?.left || window.innerWidth - 12;
    const availableWidth = rightLimit - left - 8;

    if (
      anchorRect.width <= 0 ||
      anchorRect.height <= 0 ||
      anchorRect.bottom < 0 ||
      anchorRect.top > window.innerHeight ||
      availableWidth <= 0
    ) {
      badge.dataset.visible = "false";
      return false;
    }

    badge.style.left = `${left}px`;
    badge.style.top = `${anchorRect.top + anchorRect.height / 2}px`;
    badge.dataset.layout = "full";
    badge.dataset.visible = "true";

    if (badge.getBoundingClientRect().width > availableWidth) {
      badge.dataset.layout = "compact";
    }

    if (badge.getBoundingClientRect().width > availableWidth) {
      badge.dataset.visible = "false";
      return false;
    }

    return true;
  }

  function scheduleBadgePosition() {
    if (positionFrame) return;

    positionFrame = window.requestAnimationFrame(() => {
      positionFrame = 0;
      updateBadgePosition();
    });
  }

  function removeBadge() {
    getBadge()?.remove();
  }

  function renderLoadingBadge() {
    if (!findVideoPodHeader()?.querySelector(".header-top")) return false;

    const badge = ensureBadge();
    if (!badge) return false;

    setBadgeContent(badge, "总时长 统计中…", "统计中…");
    badge.title = "正在统计当前合集/多 P 视频总时长";
    badge.setAttribute("aria-label", "正在统计合集总时长");
    badge.dataset.state = "loading";
    return updateBadgePosition();
  }

  function renderBadge(result) {
    if (!findVideoPodHeader()?.querySelector(".header-top")) return false;

    const badge = ensureBadge();
    if (!badge) return false;

    const duration = formatDuration(result.totalSeconds);
    setBadgeContent(badge, `总时长 ${duration}`, duration);
    badge.title = `共 ${result.count} 个视频`;
    badge.setAttribute("aria-label", "合集总时长");
    badge.dataset.state = "ready";
    badge.dataset.source = result.source;
    badge.dataset.count = String(result.count);
    return updateBadgePosition();
  }

  function getPageKey() {
    return `${getCurrentBvid()}::${location.pathname}${location.search}`;
  }

  async function refresh() {
    const pageKey = getPageKey();
    const bvid = getCurrentBvid();
    const sequence = ++refreshSequence;
    activeRequest?.abort();
    const request = new AbortController();
    activeRequest = request;

    try {
      renderLoadingBadge();

      let result = collectFromInitialState(bvid);

      if (!result && bvid) {
        result = await collectFromApi(bvid, request.signal);
      }

      if (sequence !== refreshSequence || pageKey !== getPageKey()) {
        return;
      }

      if (!result) {
        result = collectFromDom();
      }

      if (!result || result.count <= 1 || result.totalSeconds <= 0) {
        lastPageKey = pageKey;
        nextRetryAt = Date.now() + 3000;
        removeBadge();
        return;
      }

      const rendered = renderBadge(result);
      if (rendered) {
        lastPageKey = pageKey;
        nextRetryAt = 0;
        log(
          `已统计 ${result.count} 个视频，总时长 ${formatDuration(result.totalSeconds)}，来源 ${result.source}`,
        );
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        return;
      }

      if (sequence === refreshSequence && pageKey === getPageKey()) {
        nextRetryAt = Date.now() + 3000;
        removeBadge();
      }
      log("统计失败", error);
    } finally {
      if (sequence === refreshSequence) {
        activeRequest = null;
      }
    }
  }

  function scheduleRefresh(delay = 250) {
    clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(refresh, delay);
  }

  function notifyRouteChange() {
    lastObservedUrl = location.href;
    refreshSequence += 1;
    activeRequest?.abort();
    activeRequest = null;
    lastPageKey = "";
    nextRetryAt = 0;
    removeBadge();
    clearTimeout(routeTimer);
    routeTimer = window.setTimeout(() => {
      scheduleRefresh(100);
    }, 100);
  }

  function installRouteHooks() {
    // Do not patch pushState/replaceState. Bilibili wraps the History API during
    // SPA navigation, and replacing those methods can interrupt page startup.
    window.addEventListener("popstate", notifyRouteChange);
    window.addEventListener("hashchange", notifyRouteChange);
  }

  installRouteHooks();
  window.addEventListener("scroll", scheduleBadgePosition, { passive: true });
  window.addEventListener("resize", scheduleBadgePosition);
  window.setInterval(() => {
    if (location.href !== lastObservedUrl) {
      notifyRouteChange();
      return;
    }

    updateBadgePosition();

    const headerExists = Boolean(
      findVideoPodHeader()?.querySelector(".header-top"),
    );
    const badgeMissing = !getBadge();

    const retryReady = Date.now() >= nextRetryAt;
    if (
      !activeRequest &&
      retryReady &&
      headerExists &&
      (badgeMissing || getPageKey() !== lastPageKey)
    ) {
      scheduleRefresh(0);
    }
  }, 500);
  scheduleRefresh(0);
})();
