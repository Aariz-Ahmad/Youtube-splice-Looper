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
  const REFINE_FADE_MS = 150; // fixed fade for refine's scan blackout - one-shot, not repeating, so not exposed as a setting

  const SETTINGS_KEY = 'ytsl_settings';
  const DEFAULT_SETTINGS = {
    fadeMs: 130,
    keys: { setStart: '[', setEnd: ']', toggleLoop: '\\', refine: 'Enter' },
  };
  let fadeMs = DEFAULT_SETTINGS.fadeMs;
  let keyBinds = { ...DEFAULT_SETTINGS.keys };

  const REFINE_RADIUS = 0.6; // seconds either side of a point to search for a better match
  const REFINE_WINDOW = REFINE_RADIUS * 2 + 0.15; // capture length per point
  const TEMPLATE_LEN = 0.28; // seconds, the snippet used as the fingerprint - motif-sized, not just a transient
  const DECIMATE = 8; // crude downsample factor to keep the correlation fast
  const MIN_ENERGY_RATIO = 0.35; // candidate windows quieter than this fraction of the anchor get skipped, so it can't hide in a gap

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

  // audio routing, wired up lazily the first time a loop is armed
  let audioCtx = null;
  let mediaSource = null;
  let gainNode = null;
  let scriptNode = null;
  let audioGraphReady = false;
  let audioGraphVideoEl = null;
  let refining = false;

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

  function applySettings(s) {
    if (!s) s = {};
    fadeMs = Math.max(0, Math.min(500, typeof s.fadeMs === 'number' ? s.fadeMs : DEFAULT_SETTINGS.fadeMs));
    keyBinds = { ...DEFAULT_SETTINGS.keys, ...(s.keys || {}) };
  }

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get([SETTINGS_KEY], (result) => {
        applySettings(result[SETTINGS_KEY]);
        resolve();
      });
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) applySettings(changes[SETTINGS_KEY].newValue);
  });


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

  function ensureAudioGraph() {
    if (!video) return false;
    if (audioGraphReady && audioGraphVideoEl === video) return true;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      mediaSource = audioCtx.createMediaElementSource(video);
      gainNode = audioCtx.createGain();
      mediaSource.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      // separate silent tap so we can grab raw samples for refine without
      // touching what actually reaches the speakers
      scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);
      const silentSink = audioCtx.createGain();
      silentSink.gain.value = 0;
      mediaSource.connect(scriptNode);
      scriptNode.connect(silentSink);
      silentSink.connect(audioCtx.destination);

      audioGraphReady = true;
      audioGraphVideoEl = video;
    } catch (err) {
      // probably some other extension already claimed this video's audio graph
      console.warn('[Splice Looper] no audio routing, falling back to visual-only fade', err);
      audioGraphReady = false;
    }
    return audioGraphReady;
  }

  // refine - snap loopEnd to the best-matching spot near where it already is

  function seekAndWait(time) {
    return new Promise((resolve) => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        resolve();
      };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = time;
    });
  }

  function captureSamples(durationSec) {
    return new Promise((resolve) => {
      const needed = Math.ceil(durationSec * audioCtx.sampleRate);
      const chunks = [];
      let collected = 0;
      scriptNode.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(data));
        collected += data.length;
        if (collected >= needed) {
          scriptNode.onaudioprocess = null;
          const out = new Float32Array(collected);
          let offset = 0;
          for (const c of chunks) {
            out.set(c, offset);
            offset += c.length;
          }
          resolve(out.subarray(0, needed));
        }
      };
    });
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('capture timeout')), ms)),
    ]);
  }

  async function captureAround(centerTime) {
    await seekAndWait(Math.max(0, centerTime - REFINE_RADIUS));
    await video.play();
    return captureSamples(REFINE_WINDOW);
  }

  function decimate(arr, factor) {
    const out = new Float32Array(Math.floor(arr.length / factor));
    for (let i = 0; i < out.length; i++) out[i] = arr[i * factor];
    return out;
  }

  function rms(arr) {
    let sum = 0;
    for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
    return Math.sqrt(sum / arr.length);
  }

  function normalizedCorrelation(a, b, energyA, energyB) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    const denom = energyA * energyB * a.length;
    return denom > 0 ? dot / denom : -Infinity;
  }

  function findBestOffset(startBuf, endBuf, sampleRate) {
    const templateHalf = Math.round((TEMPLATE_LEN / 2) * sampleRate);
    const centerIdx = Math.round(REFINE_RADIUS * sampleRate);
    const template = decimate(
      startBuf.subarray(Math.max(0, centerIdx - templateHalf), centerIdx + templateHalf),
      DECIMATE
    );
    const search = decimate(endBuf, DECIMATE);
    const decRate = sampleRate / DECIMATE;

    const templateEnergy = rms(template);
    const minEnergy = templateEnergy * MIN_ENERGY_RATIO;

    let bestScore = -Infinity;
    let bestIdx = Math.round(search.length / 2);
    for (let i = 0; i <= search.length - template.length; i++) {
      const window = search.subarray(i, i + template.length);
      const windowEnergy = rms(window);
      if (windowEnergy < minEnergy) continue; // too quiet to be the real motif, skip it

      const score = normalizedCorrelation(template, window, templateEnergy, windowEnergy);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    const matchCenter = bestIdx + Math.floor(template.length / 2);
    return matchCenter / decRate;
  }

  async function refineLoop() {
    if (refining || !video || !loopEnabled) return;
    if (loopStart == null || loopEnd == null) return;
    if (loopEnd - loopStart < REFINE_RADIUS * 2 + TEMPLATE_LEN) return;
    if (!ensureAudioGraph()) return;

    refining = true;
    const wasPaused = video.paused;
    const returnTime = video.currentTime;
    const priorGain = gainNode.gain.value;

    gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
    gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
    video.style.transitionDuration = REFINE_FADE_MS + 'ms';
    video.style.opacity = '0';

    try {
      const startBuf = await withTimeout(captureAround(loopStart), 3000);
      const endBuf = await withTimeout(captureAround(loopEnd), 3000);
      const offsetSec = findBestOffset(startBuf, endBuf, audioCtx.sampleRate);
      const refinedEnd = loopEnd - REFINE_RADIUS + offsetSec;
      loopEnd = Math.min(video.duration || refinedEnd, Math.max(loopStart + MIN_GAP, refinedEnd));
      renderLoopMarkers();
      saveState();
    } catch (err) {
      console.warn('[Splice Looper] refine failed, leaving loop points as-is', err);
    }

    scriptNode.onaudioprocess = null;
    video.currentTime = returnTime;
    video.style.opacity = '1';
    gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
    gainNode.gain.setValueAtTime(priorGain, audioCtx.currentTime);
    if (wasPaused) video.pause();
    refining = false;
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
      ensureAudioGraph();
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

    if (fadeMs <= 0) {
      video.currentTime = loopStart;
      return;
    }

    jumping = true;

    const audioReady = audioGraphReady && audioGraphVideoEl === video;
    if (audioReady && audioCtx.state === 'suspended') audioCtx.resume();
    if (audioReady) {
      const t0 = audioCtx.currentTime;
      gainNode.gain.cancelScheduledValues(t0);
      gainNode.gain.setValueAtTime(gainNode.gain.value, t0);
      gainNode.gain.linearRampToValueAtTime(0, t0 + fadeMs / 1000);
    }

    video.style.transitionDuration = fadeMs + 'ms';
    video.style.opacity = '0';
    setTimeout(() => {
      video.currentTime = loopStart;
      requestAnimationFrame(() => {
        video.style.opacity = '1';
        if (audioReady) {
          const t1 = audioCtx.currentTime;
          gainNode.gain.cancelScheduledValues(t1);
          gainNode.gain.setValueAtTime(0, t1);
          gainNode.gain.linearRampToValueAtTime(1, t1 + fadeMs / 1000);
        }
        setTimeout(() => {
          jumping = false;
        }, fadeMs);
      });
    }, fadeMs);
  }

  function loopTick() {
    if (
      video &&
      loopEnabled &&
      !jumping &&
      !refining &&
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

    if (e.key === keyBinds.setStart) {
      loopStart = video.currentTime;
      if (loopEnd != null && loopEnd <= loopStart) loopEnd = null;
      renderLoopMarkers();
      saveState();
    } else if (e.key === keyBinds.setEnd) {
      loopEnd = video.duration ? Math.min(video.currentTime, video.duration) : video.currentTime;
      renderLoopMarkers();
      saveState();
    } else if (e.key === keyBinds.toggleLoop) {
      toggleLoopActive();
    } else if (e.key === keyBinds.refine) {
      e.preventDefault();
      e.stopPropagation();
      refineLoop();
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

  async function init() {
    await loadSettings();
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
