/**
 * Splice Looper for YouTube
 * 
 * A single button in YouTube's native player controls arms/disarms a loop.
 * When armed, two draggable point-handles appear directly on YouTube's own
 * seek bar (styled like its native scrubber) marking the loop's start and
 * end. Drag them to define the segment live, while the video keeps playing.
 *
 * As with any YouTube extension, the fragile part is the CSS selectors
 * targeting YouTube's internal DOM (`.ytp-right-controls`,
 * `.ytp-progress-bar-container`) — not a published API, so a redesign could
 * break button/handle injection. The core loop mechanism only depends on
 * the standard <video> element and survives that regardless.
 * 
 * Annoying stuff all around.
 */



(function () {
  'use strict';

  const STORAGE_PREFIX = 'ytsl_';
  const SEEK_TOLERANCE = 1.5; // seconds; distinguishes natural playback from a manual seek
  const DEFAULT_SEGMENT_LEN = 5; // seconds, initial window when first armed
  const MIN_GAP = 0.25; // seconds; smallest allowed start/end separation
  const FADE_MS = 130; // loop-jump fade duration

  let video = null;
  let currentVideoId = null;
  let loopStart = null;
  let loopEnd = null;
  let loopEnabled = false;
  let lastTime = 0;
  let rafId = null;
  let jumping = false;

  let buttonEl = null;
  let overlayEl = null;
  let startHandle = null;
  let endHandle = null;
  let draggingHandle = null; // 'start' | 'end' | null

  // Helpers

  function getVideoId() {
    const params = new URLSearchParams(location.search);
    return params.get('v');
  }

  function storageKey(id) {
    return STORAGE_PREFIX + id;
  }

  function saveState() {
    if (!currentVideoId) return;
    chrome.storage.local.set({
      [storageKey(currentVideoId)]: {
        start: loopStart,
        end: loopEnd,
        enabled: loopEnabled,
      },
    });
  }

  function loadState(id) {
    return new Promise((resolve) => {
      chrome.storage.local.get([storageKey(id)], (result) => {
        const state = result[storageKey(id)];
        loopStart = state?.start ?? null;
        loopEnd = state?.end ?? null;
        loopEnabled = state?.enabled ?? false;
        resolve();
      });
    });
  }


  function waitForVideo() {
    return new Promise((resolve) => {
      const existing = document.querySelector('video.html5-main-video');
      if (existing) return resolve(existing);
      const obs = new MutationObserver(() => {
        const v = document.querySelector('video.html5-main-video');
        if (v) {
          obs.disconnect();
          resolve(v);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    });
  }

  function waitForControls() {
    return new Promise((resolve) => {
      const existing = document.querySelector('.ytp-right-controls');
      if (existing) return resolve(existing);
      const obs = new MutationObserver(() => {
        const c = document.querySelector('.ytp-right-controls');
        if (c) {
          obs.disconnect();
          resolve(c);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    });
  }

  function getProgressBarContainer() {
    return document.querySelector('.ytp-progress-bar-container');
  }

  //ui player button

  function injectButton(controls) {
    let btn = document.getElementById('ytsl-toggle-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'ytsl-toggle-btn';
      btn.className = 'ytp-button ytsl-button';
      btn.title = 'Splice Looper';
      btn.innerHTML =
        '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleLoopActive();
      });
      controls.prepend(btn);
    }
    buttonEl = btn;
    updateButtonState();
  }

  function updateButtonState() {
    if (!buttonEl) return;
    buttonEl.classList.toggle('ytsl-active', !!loopEnabled);
  }

  // ui for the draggable handles and overlay

  function ensureMarkerEls(container) {
    if (!overlayEl || !container.contains(overlayEl)) {
      overlayEl = document.createElement('div');
      overlayEl.className = 'ytsl-range-overlay';
      container.appendChild(overlayEl);
    }
    if (!startHandle || !container.contains(startHandle)) {
      startHandle = document.createElement('div');
      startHandle.className = 'ytsl-handle ytsl-handle-start';
      container.appendChild(startHandle);
      attachHandleDrag(startHandle, 'start');
    }
    if (!endHandle || !container.contains(endHandle)) {
      endHandle = document.createElement('div');
      endHandle.className = 'ytsl-handle ytsl-handle-end';
      container.appendChild(endHandle);
      attachHandleDrag(endHandle, 'end');
    }
  }

  function renderLoopMarkers() {
    const container = getProgressBarContainer();
    if (!container || !video) return;
    ensureMarkerEls(container);

    if (!loopEnabled || loopStart == null || loopEnd == null || !video.duration) {
      overlayEl.style.display = 'none';
      startHandle.style.display = 'none';
      endHandle.style.display = 'none';
      return;
    }

    const dur = video.duration;
    const leftPct = (loopStart / dur) * 100;
    const rightPct = (loopEnd / dur) * 100;

    overlayEl.style.display = 'block';
    overlayEl.style.left = leftPct + '%';
    overlayEl.style.width = Math.max(0, rightPct - leftPct) + '%';

    startHandle.style.display = 'block';
    startHandle.style.left = leftPct + '%';
    endHandle.style.display = 'block';
    endHandle.style.left = rightPct + '%';
  }

  // drag logic

  function attachHandleDrag(el, which) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      draggingHandle = which;
      document.addEventListener('pointermove', onHandleDrag);
      document.addEventListener('pointerup', onHandleDragEnd);
      document.addEventListener('pointercancel', onHandleDragEnd);
    });
  }

  function onHandleDrag(e) {
    if (!draggingHandle || !video || !video.duration) return;
    const container = getProgressBarContainer();
    if (!container) return;
    const rect = container.getBoundingClientRect();
    let frac = (e.clientX - rect.left) / rect.width;
    frac = Math.min(1, Math.max(0, frac));
    const t = frac * video.duration;

    if (draggingHandle === 'start') {
      const ceiling = (loopEnd ?? video.duration) - MIN_GAP;
      loopStart = Math.max(0, Math.min(t, ceiling));
    } else {
      const floor = (loopStart ?? 0) + MIN_GAP;
      loopEnd = Math.min(video.duration, Math.max(t, floor));
    }
    renderLoopMarkers();
  }

  function onHandleDragEnd() {
    draggingHandle = null;
    document.removeEventListener('pointermove', onHandleDrag);
    document.removeEventListener('pointerup', onHandleDragEnd);
    document.removeEventListener('pointercancel', onHandleDragEnd);
    saveState();
  }

  // arming and disarming hehe

  function ensureDefaultPoints() {
    if (loopStart != null && loopEnd != null && loopEnd > loopStart) return;
    const cur = video.currentTime || 0;
    const dur = video.duration || 0;
    loopStart = cur;
    loopEnd = dur ? Math.min(cur + DEFAULT_SEGMENT_LEN, dur) : cur + DEFAULT_SEGMENT_LEN;
    if (loopEnd <= loopStart) loopEnd = loopStart + DEFAULT_SEGMENT_LEN;
  }

  function toggleLoopActive() {
    if (!video) return;
    if (!loopEnabled) {
      ensureDefaultPoints();
      loopEnabled = true;
    } else {
      loopEnabled = false;
    }
    updateButtonState();
    renderLoopMarkers();
    saveState();
  }

  //loop functionality

  function performLoopJump() {
    if (jumping || !video) return;
    jumping = true;
    video.style.opacity = '0';
    setTimeout(() => {
      video.currentTime = loopStart;
      requestAnimationFrame(() => {
        video.style.opacity = '1';
        setTimeout(() => {
          jumping = false;
        }, FADE_MS);
      });
    }, FADE_MS);
  }

  function loopTick() {
    if (
      video &&
      loopEnabled &&
      !jumping &&
      loopStart != null &&
      loopEnd != null &&
      loopEnd > loopStart
    ) {
      const t = video.currentTime;
      const delta = t - lastTime;
      if (delta >= 0 && delta < SEEK_TOLERANCE && t >= loopEnd) {
        performLoopJump();
      }
    }
    lastTime = video ? video.currentTime : 0;
    rafId = requestAnimationFrame(loopTick);
  }

  // shortcuts

  function onKeydown(e) {
    const tag = document.activeElement && document.activeElement.tagName;
    const editable =
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      (document.activeElement && document.activeElement.isContentEditable);
    if (editable || !video) return;

    if (e.key === '[') {
      loopStart = video.currentTime;
      if (loopEnd != null && loopEnd <= loopStart) loopEnd = null;
      renderLoopMarkers();
      saveState();
    } else if (e.key === ']') {
      loopEnd = video.duration ? Math.min(video.currentTime, video.duration) : video.currentTime;
      renderLoopMarkers();
      saveState();
    } else if (e.key === '\\') {
      toggleLoopActive();
    }
  }



  async function setupForVideo(id) {
    currentVideoId = id;
    await loadState(id);

    video = await waitForVideo();
    video.style.opacity = '';
    video.classList.add('ytsl-loop-fade');

    const controls = await waitForControls();
    injectButton(controls);

    if (video.readyState >= 1) clampToDuration();
    else video.addEventListener('loadedmetadata', clampToDuration, { once: true });

    updateButtonState();
    renderLoopMarkers();
  }

  function clampToDuration() {
    if (video && video.duration && loopEnd != null && loopEnd > video.duration) {
      loopEnd = video.duration;
      saveState();
    }
    renderLoopMarkers();
  }

  function teardown() {
    currentVideoId = null;
    video = null;
    loopStart = null;
    loopEnd = null;
    loopEnabled = false;
  }

  function handlePossibleNavigation() {
    const id = getVideoId();
    if (!id) {
      teardown();
      return;
    }
    if (id === currentVideoId) return;
    setupForVideo(id);
  }

  function init() {
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('yt-navigate-finish', handlePossibleNavigation);
    // Fallback in case yt-navigate-finish isn't fired in some YouTube build.
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        handlePossibleNavigation();
      }
    }, 1000);

    rafId = requestAnimationFrame(loopTick);
    handlePossibleNavigation();
  }

  init();
})();
