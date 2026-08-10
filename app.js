/* ═══════════════════════════════════════════════════
   ASPOTÏ · app.js v3 — Full Enhanced Edition
   Fixes: progress/duration, no horizontal scroll on
   drag, working volume slider, native app feel,
   featured playlists & trending home feed.
   ═══════════════════════════════════════════════════ */
'use strict';

/* ── STORAGE ── */
const DB = {
  _k: k => 'aspoti_' + k,
  get(k, fb = null) { try { const v = localStorage.getItem(this._k(k)); return v ? JSON.parse(v) : fb; } catch { return fb; } },
  set(k, v) { try { localStorage.setItem(this._k(k), JSON.stringify(v)); } catch {} },
};

/* ── STATE ── */
const state = {
  apiKey: 'AIzaSyBgibbTvE7Khph08tK5BlVOjZ3DGk_nTYk',
  playlists:        DB.get('playlists', []),
  liked:            DB.get('liked', []),
  history:          DB.get('history', []),
  queue:            [],
  queueIdx:         -1,
  shuffle:          false,
  repeat:           'none',
  playing:          false,
  loading:          false,
  currentTrack:     null,
  currentDuration:  0,
  volumeLevel:      DB.get('volume', 80),
  currentPlaylistId: null,
  currentGenre:     'Pop',
};

const save = {
  playlists() { DB.set('playlists', state.playlists); },
  liked()     { DB.set('liked',     state.liked);     },
  history()   { DB.set('history',   state.history);   },
  volume()    { DB.set('volume',    state.volumeLevel); },
};

/* ════════════════════════════════════════════════════
   NATIVE AUDIO ENGINE
   ════════════════════════════════════════════════════ */
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://yewtu.be',
  'https://invidious.privacyredirect.com',
  'https://invidious.jing.rocks',
  'https://invidious.nerdvpn.de',
  'https://yt.omada.cafe',
  'https://iv.datura.network',
  'https://invidious.privacydev.net',
];

/* ── INSTANCE HEALTH TRACKER ──
   Keeps a lightweight score per instance. Successful fetches boost the score;
   failures reduce it. Instances are tried fastest-first by sorting on score,
   so a dead instance drifts to the back over time automatically.
   Scores are session-only (no localStorage) to avoid stale data across sessions. */
const instanceHealth = (() => {
  const scores = {};
  INVIDIOUS_INSTANCES.forEach(b => { scores[b] = 50; }); // Start neutral at 50
  return {
    success(base) { scores[base] = Math.min(100, (scores[base] || 50) + 20); },
    failure(base) { scores[base] = Math.max(0,   (scores[base] || 50) - 15); },
    sorted()      { return [...INVIDIOUS_INSTANCES].sort((a, b) => (scores[b] || 0) - (scores[a] || 0)); },
  };
})();

/* ── STREAM URL CACHE ──
   Caches resolved stream URLs keyed by videoId for ~8 minutes.
   Invidious stream tokens typically expire after ~6h, but we use a short TTL
   so we always get a fresh URL after a pause of 8+ minutes (common on iOS
   when the user locks the screen). This avoids the most common "re-play from
   scratch" scenario while also preventing stale 403s on long sessions. */
const streamCache = (() => {
  const cache = new Map(); // videoId → { url, duration, ts }
  const TTL = 8 * 60 * 1000; // 8 minutes
  return {
    get(videoId) {
      const entry = cache.get(videoId);
      if (!entry) return null;
      if (Date.now() - entry.ts > TTL) { cache.delete(videoId); return null; }
      return entry;
    },
    set(videoId, url, duration) {
      cache.set(videoId, { url, duration, ts: Date.now() });
      // Keep cache small — evict oldest if > 30 entries
      if (cache.size > 30) {
        const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
        if (oldest) cache.delete(oldest[0]);
      }
    },
  };
})();

const AUDIO = new Audio();
AUDIO.preload = 'none';
AUDIO.setAttribute('playsinline', '');

AUDIO.addEventListener('play',    () => onAudioPlay());
AUDIO.addEventListener('pause',   () => onAudioPause());
AUDIO.addEventListener('ended',   () => onAudioEnded());
AUDIO.addEventListener('error',   () => onAudioError());
AUDIO.addEventListener('waiting', () => showLoadingState(true));
AUDIO.addEventListener('canplay', () => showLoadingState(false));
// NOTE: We intentionally do NOT update state.currentDuration from loadedmetadata
// or durationchange. Invidious adaptive audio streams frequently report double
// the real duration (e.g. 3:20 → 6:40) because the stream container includes
// both audio and video duration metadata. We rely solely on the API's
// lengthSeconds value set in loadStreamForTrack, which is always accurate.
AUDIO.addEventListener('loadedmetadata', () => {
  // Only use audio element duration as a fallback if the API gave us nothing
  if (state.currentDuration <= 0 && AUDIO.duration && isFinite(AUDIO.duration)) {
    state.currentDuration = AUDIO.duration;
    el('np-duration').textContent = fmtTime(state.currentDuration);
  }
});
// durationchange is suppressed entirely — it fires with doubled values on iOS
// for Invidious adaptive streams and would overwrite our correct API duration.

function onAudioPlay() {
  state.playing = true;
  state.loading = false;
  showLoadingState(false);
  updatePlayIcons(true);
  artContainer.classList.add('playing');
  artContainer.classList.remove('paused');
  startProgressLoop();
  startBgEndTimer();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
}

function onAudioPause() {
  // Always stop the progress RAF and background end timer when audio pauses.
  if (progressRAF) { cancelAnimationFrame(progressRAF); progressRAF = null; }
  stopBgEndTimer();

  // If the page is hidden, this pause was triggered by iOS interrupting the
  // audio session (screen lock, phone call, app switch) — NOT by the user.
  // Keep state.playing = true so the visibility-resume logic knows to retry.
  // (Intentional lock-screen pauses are handled by the media session handler
  //  which sets state.playing = false directly before this fires.)
  if (document.visibilityState === 'hidden') return;

  state.playing = false;
  updatePlayIcons(false);
  artContainer.classList.remove('playing');
  artContainer.classList.add('paused');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
}

function onAudioEnded() {
  // Always stop the progress RAF and background timer first.
  if (progressRAF) { cancelAnimationFrame(progressRAF); progressRAF = null; }
  stopBgEndTimer();

  if (state.repeat === 'one') {
    // Seek to 0 and replay. This works in foreground. In background the
    // bgEndTimer fires before this point and handles the seek itself.
    AUDIO.currentTime = 0;
    AUDIO.play().catch(() => { if (state.currentTrack) loadStreamForTrack(state.currentTrack); });
    return;
  }
  state.playing = false;
  updatePlayIcons(false);
  seekNext();
}

/* ── BACKGROUND END TIMER ──
   The core problem on iOS:
   - Invidious adaptive streams embed both audio+video duration in their
     container, so iOS sees a duration ~2× the real song length.
   - Because of this, the 'ended' event fires late or never when the screen
     is locked, and AUDIO.loop loops at the wrong point.
   - requestAnimationFrame is suspended in background so the RAF safety-net
     never runs either.

   Solution: when a track starts, record the wall-clock start time and the
   known song duration. A setInterval (which iOS DOES keep running for active
   audio PWAs) checks every second whether real elapsed time ≥ song duration.
   When it fires, we seek AUDIO.currentTime back to 0 and call play() —
   this is allowed by iOS because it's triggered by the audio session's own
   timer, not an arbitrary user-gesture-less call. For repeat-all / no-repeat
   we call onAudioEnded() instead so normal queue advance logic runs. */
let _bgEndTimer   = null;
let _trackStartWall = 0;   // Date.now() when current track began playing
let _trackStartAudio = 0;  // AUDIO.currentTime at that moment (usually 0)

function startBgEndTimer() {
  stopBgEndTimer();
  if (!state.currentDuration || state.currentDuration <= 0) return;

  _trackStartWall  = Date.now();
  _trackStartAudio = AUDIO.currentTime || 0;

  _bgEndTimer = setInterval(() => {
    if (AUDIO.paused || !state.currentDuration) return;

    // Wall-clock elapsed since track started, offset by where we started.
    const wallElapsed = (Date.now() - _trackStartWall) / 1000;
    const elapsed     = _trackStartAudio + wallElapsed;

    if (elapsed < state.currentDuration - 0.5) return; // not there yet

    // Song is over (or within 0.5 s of the end).
    console.log(`[BgEndTimer] Song ended (elapsed ${elapsed.toFixed(1)}s / ${state.currentDuration}s)`);
    stopBgEndTimer();

    if (state.repeat === 'one') {
      // Seek back to start and keep going — works in background on iOS.
      AUDIO.currentTime = 0;
      _trackStartWall  = Date.now();
      _trackStartAudio = 0;
      AUDIO.play().catch(() => { if (state.currentTrack) loadStreamForTrack(state.currentTrack); });
      // Restart the timer for the next loop.
      startBgEndTimer();
    } else {
      // For repeat-all / no-repeat, use the existing ended logic.
      // onAudioEnded will call seekNext() which handles queue advance.
      AUDIO.pause();
      onAudioEnded();
    }
  }, 1000);
}

function stopBgEndTimer() {
  if (_bgEndTimer) { clearInterval(_bgEndTimer); _bgEndTimer = null; }
}

// Also reset the wall-clock anchor whenever the user seeks manually,
// so the timer doesn't misfire after a seek.
AUDIO.addEventListener('seeked', () => {
  if (_bgEndTimer) {
    _trackStartWall  = Date.now();
    _trackStartAudio = AUDIO.currentTime || 0;
  }
});

function onAudioError() {
  console.warn('Audio element error — stream URL may have expired or be unsupported');
  showLoadingState(false);
  if (state.currentTrack) {
    toast('Stream error — retrying...');
    setTimeout(() => loadStreamForTrack(state.currentTrack), 1000);
  }
}

function pickBestAudioStream(adaptiveFormats) {
  const audioFormats = adaptiveFormats.filter(f => {
    const t = f.type || f.mimeType || '';
    return t.startsWith('audio');
  });
  if (!audioFormats.length) return null;
  const opus = audioFormats.filter(f => { const t = f.type || f.mimeType || ''; return t.includes('opus') || t.includes('webm'); });
  const aac  = audioFormats.filter(f => { const t = f.type || f.mimeType || ''; return t.includes('mp4') || t.includes('aac') || t.includes('mp4a'); });
  const sortByBitrate = arr => arr.sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));
  sortByBitrate(opus); sortByBitrate(aac);
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const preferred = isIOS ? (aac[0] || opus[0]) : (opus[0] || aac[0]);
  return preferred || audioFormats[0];
}

async function fetchFromInvidious(base, videoId, signal) {
  const url = base ? `${base}/api/v1/videos/${videoId}` : `/api/v1/videos/${videoId}`;
  // Use a 4 s per-instance timeout when racing (fail fast so the winner
  // resolves quickly); the caller also holds an outer AbortController.
  const timeoutSignal = AbortSignal.timeout(4000);
  const combinedSignal = signal
    ? AbortSignal.any ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    : timeoutSignal;
  const res = await fetch(url, { signal: combinedSignal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !('adaptiveFormats' in data) || !Array.isArray(data.adaptiveFormats)) throw new Error(data?.error || 'adaptiveFormats missing');
  if (!data.adaptiveFormats.some(f => (f.type || f.mimeType || '').startsWith('audio'))) throw new Error('no audio streams');
  return data;
}

/* resolveAudioUrl — races all Invidious instances in parallel.
   The first instance to return a valid audio stream wins; the rest are
   cancelled immediately. This slashes worst-case resolution time from
   potentially 16 s (sequential, 2 dead instances × 8 s timeout) down to
   the time it takes the fastest live instance to respond (~1-2 s typical).
   Instance health scores bias the order so known-good instances are tried
   (and usually win) while dead ones stay quiet at the back. */
async function resolveAudioUrl(videoId) {
  // Fast path: serve from cache if fresh
  const cached = streamCache.get(videoId);
  if (cached) {
    console.log(`[StreamCache] HIT for ${videoId}`);
    return { url: cached.url, duration: cached.duration };
  }

  const outer = new AbortController();
  const instances = instanceHealth.sorted();

  return new Promise(resolve => {
    let settled = false;
    let pending = instances.length;

    instances.forEach(base => {
      fetchFromInvidious(base, videoId, outer.signal)
        .then(data => {
          if (settled) return;
          const stream = pickBestAudioStream(data.adaptiveFormats);
          if (!stream?.url) throw new Error('no usable stream');
          settled = true;
          outer.abort(); // cancel all other in-flight requests
          instanceHealth.success(base);
          console.log(`[Invidious] ✓ ${base} → ${stream.type || stream.mimeType} @ ${stream.bitrate}bps`);
          const result = { url: stream.url, duration: data.lengthSeconds || 0 };
          streamCache.set(videoId, result.url, result.duration);
          resolve(result);
        })
        .catch(e => {
          if (!outer.signal.aborted) {
            instanceHealth.failure(base);
            console.warn(`[Invidious] ✗ ${base}:`, e.message);
          }
          pending--;
          if (pending === 0 && !settled) resolve(null); // all failed
        });
    });
  });
}

async function loadStreamForTrack(track) {
  showLoadingState(true);
  const result = await resolveAudioUrl(track.videoId);
  if (!result) { showLoadingState(false); toast('No audio source found — check your connection'); return; }
  if (state.currentTrack?.videoId !== track.videoId) return;

  // Set duration immediately from API metadata — don't wait for loadedmetadata.
  // Invidious always returns lengthSeconds; this is far more reliable on iOS
  // where loadedmetadata often fires late or with Infinity for stream URLs.
  if (result.duration > 0) {
    state.currentDuration = result.duration;
    el('np-duration').textContent = fmtTime(result.duration);
  }

  AUDIO.src = result.url;
  AUDIO.volume = state.volumeLevel / 100;
  AUDIO.loop = false; // never rely on native loop — Invidious stream containers
                      // report 2× real duration so native loop fires at the wrong point.
  AUDIO.load();
  AUDIO.play().catch(e => { console.warn('play() blocked:', e); showLoadingState(false); updatePlayIcons(false); });
}

/* ── NEXT-TRACK PRELOAD ──
   Silently resolves and caches the stream URL for the next track in the
   queue while the current one is playing, so skipping forward feels instant.
   Fires once per track after a 15 s delay (gives the current track time to
   actually start, avoids racing during the initial load). */
let _preloadTimer = null;
function scheduleNextTrackPreload() {
  if (_preloadTimer) { clearTimeout(_preloadTimer); _preloadTimer = null; }
  _preloadTimer = setTimeout(() => {
    _preloadTimer = null;
    const nextIdx = state.shuffle
      ? null // can't predict shuffle pick
      : state.queueIdx + 1;
    if (nextIdx === null || nextIdx >= state.queue.length) return;
    const nextTrack = state.queue[nextIdx];
    if (!nextTrack || streamCache.get(nextTrack.videoId)) return; // already cached
    console.log(`[Preload] Warming cache for next track: ${nextTrack.title}`);
    resolveAudioUrl(nextTrack.videoId).catch(() => {}); // fire-and-forget
  }, 15000); // 15 s after current track starts
}

/* ── PLAYBACK CONTROLS ── */
async function playTrack(track, queueOverride, idx) {
  if (queueOverride) { state.queue = queueOverride; state.queueIdx = idx ?? 0; }
  state.currentTrack = track;
  state.playing = false;
  state.loading = true;
  state.currentDuration = 0;
  updateNowPlaying(track);
  updateMiniPlayer(track);
  updateArtColor(track.thumb);
  resetProgressUI();
  setupMediaSession(track);
  showLoadingState(true);
  addToHistory(track);
  loadStreamForTrack(track);
  scheduleNextTrackPreload();
}

function togglePlayPause() {
  if (!state.currentTrack) return;
  if (state.playing) {
    AUDIO.pause();
  } else {
    if (!AUDIO.src || AUDIO.src === window.location.href) {
      loadStreamForTrack(state.currentTrack);
    } else {
      AUDIO.play().catch(() => {});
    }
  }
}

function seekPrev() {
  if (AUDIO.currentTime > 3) { AUDIO.currentTime = 0; return; }
  if (state.queueIdx > 0) { state.queueIdx--; playTrack(state.queue[state.queueIdx]); }
  else if (state.repeat === 'all' && state.queue.length) { state.queueIdx = state.queue.length - 1; playTrack(state.queue[state.queueIdx]); }
}

function seekNext() {
  if (state.shuffle && state.queue.length > 1) {
    let next; do { next = Math.floor(Math.random() * state.queue.length); } while (next === state.queueIdx);
    state.queueIdx = next; playTrack(state.queue[next]); return;
  }
  if (state.queueIdx < state.queue.length - 1) {
    state.queueIdx++;
    playTrack(state.queue[state.queueIdx]);
  } else if (state.repeat === 'all' && state.queue.length) {
    state.queueIdx = 0;
    playTrack(state.queue[0]);
  } else {
    // Queue exhausted — load genre radio so playback continues naturally.
    // Uses the current track's artist as a seed for a related-genre search,
    // so it won't just queue up the same song name again.
    loadGenreRadio();
  }
}

async function loadGenreRadio() {
  if (!state.currentTrack) return;
  showLoadingState(true);
  // Build a genre/artist seed query — avoids repeating the exact track title
  const artist = state.currentTrack.artist.replace(/\s*-\s*Topic$/, '').trim();
  const genre  = state.currentGenre || 'Pop';
  const query  = `${artist} ${genre} mix`;
  const results = await searchYouTube(query);
  showLoadingState(false);
  if (!results || !results.length) return;
  // Filter out the currently playing song
  const filtered = results.filter(r => r.videoId !== state.currentTrack?.videoId);
  if (!filtered.length) return;
  state.queue    = filtered;
  state.queueIdx = 0;
  el('np-queue-name').textContent = `${artist} Radio`;
  playTrack(filtered[0]);
}

/* ── LOADING STATE ── */
function showLoadingState(loading) {
  state.loading = loading;
  const ppPlay = el('pp-play'), ppPause = el('pp-pause'), ppSpin = el('pp-spin');
  if (!ppPlay) return;
  if (loading) { ppPlay.style.display = 'none'; ppPause.style.display = 'none'; if (ppSpin) ppSpin.style.display = ''; }
  else { if (ppSpin) ppSpin.style.display = 'none'; updatePlayIcons(state.playing); }
}

/* ── PROGRESS LOOP ── */
let progressRAF = null;
function startProgressLoop() {
  if (progressRAF) cancelAnimationFrame(progressRAF);
  function tick() {
    if (!state.playing) return;
    const raw = AUDIO.currentTime || 0;
    // Always use the API-supplied duration (state.currentDuration).
    // AUDIO.duration can be doubled for Invidious adaptive streams on iOS,
    // so the 'ended' event may never fire even though the song is over.
    const dur = state.currentDuration > 0 ? state.currentDuration : 0;
    // Clamp displayed time so it never runs past the real song length.
    const cur = dur > 0 ? Math.min(raw, dur) : raw;
    const pct = dur ? (cur / dur) * 100 : 0;
    updateProgressUI(pct, cur, dur);
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && dur > 0) {
      try { navigator.mediaSession.setPositionState({ duration: dur, playbackRate: 1, position: cur }); } catch {}
    }
    // Safety net: if the stream has played past the known song duration by more
    // than 1 second, the 'ended' event is never coming — trigger it manually.
    if (dur > 0 && raw >= dur + 1 && !AUDIO.paused) {
      AUDIO.pause();
      onAudioEnded();
      return;
    }
    progressRAF = requestAnimationFrame(tick);
  }
  progressRAF = requestAnimationFrame(tick);
}

function updateProgressUI(pct, cur, dur) {
  const safePct = Math.max(0, Math.min(100, pct || 0));
  // Update custom progress bar
  const fill = el('progress-fill');
  const thumb = el('progress-thumb');
  if (fill) fill.style.width = safePct + '%';
  if (thumb) thumb.style.left = safePct + '%';
  // Update mini player progress
  const miniPb = el('mini-progress-bar');
  if (miniPb) miniPb.style.width = safePct + '%';
  // Update time labels
  el('np-current').textContent  = fmtTime(cur || 0);
  if (dur > 0) el('np-duration').textContent = fmtTime(dur);
}

function resetProgressUI() {
  updateProgressUI(0, 0, 0);
  el('np-duration').textContent = '0:00';
}

/* ── CUSTOM PROGRESS DRAG ── */
function setupCustomSliders() {
  // Progress slider
  const pTrack = el('progress-track');
  if (pTrack) {
    let dragging = false;

    function getProgressPct(e) {
      const rect = pTrack.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    }

    function applyProgress(pct) {
      const fill = el('progress-fill'), thumb = el('progress-thumb');
      if (fill) fill.style.width = (pct * 100) + '%';
      if (thumb) thumb.style.left = (pct * 100) + '%';
      const miniPb = el('mini-progress-bar');
      if (miniPb) miniPb.style.width = (pct * 100) + '%';
      el('np-current').textContent = fmtTime(pct * state.currentDuration);
    }

    pTrack.addEventListener('touchstart', e => {
      dragging = true;
      pTrack.classList.add('dragging');
      if (progressRAF) { cancelAnimationFrame(progressRAF); progressRAF = null; }
      applyProgress(getProgressPct(e));
    }, { passive: true });

    document.addEventListener('touchmove', e => {
      if (!dragging) return;
      // Allow only vertical for page, horizontal for slider
      applyProgress(getProgressPct(e));
    }, { passive: true });

    document.addEventListener('touchend', () => {
      if (!dragging) return;
      dragging = false;
      pTrack.classList.remove('dragging');
      const fill = el('progress-fill');
      const pct = fill ? parseFloat(fill.style.width) / 100 : 0;
      if (state.currentDuration > 0) {
        AUDIO.currentTime = pct * state.currentDuration;
      }
      if (state.playing) startProgressLoop();
    });

    pTrack.addEventListener('mousedown', e => {
      dragging = true;
      pTrack.classList.add('dragging');
      if (progressRAF) { cancelAnimationFrame(progressRAF); progressRAF = null; }
      applyProgress(getProgressPct(e));
    });
    document.addEventListener('mousemove', e => { if (dragging) applyProgress(getProgressPct(e)); });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      pTrack.classList.remove('dragging');
      const fill = el('progress-fill');
      const pct = fill ? parseFloat(fill.style.width) / 100 : 0;
      if (state.currentDuration > 0) AUDIO.currentTime = pct * state.currentDuration;
      if (state.playing) startProgressLoop();
    });

    // Tap-to-seek
    pTrack.addEventListener('click', e => {
      const pct = getProgressPct(e);
      if (state.currentDuration > 0) {
        AUDIO.currentTime = pct * state.currentDuration;
        applyProgress(pct);
      }
    });
  }

  // Volume slider
  const vTrack = el('volume-track');
  if (vTrack) {
    let vDragging = false;

    function getVolumePct(e) {
      const rect = vTrack.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    }

    function applyVolume(pct) {
      state.volumeLevel = Math.round(pct * 100);
      AUDIO.volume = pct;
      const fill = el('volume-fill'), thumb = el('volume-thumb');
      if (fill) fill.style.width = (pct * 100) + '%';
      if (thumb) thumb.style.left = (pct * 100) + '%';
      save.volume();
    }

    vTrack.addEventListener('touchstart', e => { vDragging = true; applyVolume(getVolumePct(e)); }, { passive: true });
    document.addEventListener('touchmove', e => { if (vDragging) applyVolume(getVolumePct(e)); }, { passive: true });
    document.addEventListener('touchend', () => { vDragging = false; });
    vTrack.addEventListener('mousedown', e => { vDragging = true; applyVolume(getVolumePct(e)); });
    document.addEventListener('mousemove', e => { if (vDragging) applyVolume(getVolumePct(e)); });
    document.addEventListener('mouseup', () => { vDragging = false; });
    vTrack.addEventListener('click', e => applyVolume(getVolumePct(e)));

    // Init volume display
    const pct = state.volumeLevel / 100;
    const fill = el('volume-fill'), thumb = el('volume-thumb');
    if (fill) fill.style.width = (pct * 100) + '%';
    if (thumb) thumb.style.left = (pct * 100) + '%';
    AUDIO.volume = pct;
  }
}

/* ── MEDIA SESSION API ── */
function setupMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title, artist: track.artist, album: 'Aspotï',
    artwork: track.thumb ? [{ src: track.thumb, sizes: '320x180', type: 'image/jpeg' }, { src: track.thumb, sizes: '640x360', type: 'image/jpeg' }] : [],
  });
  navigator.mediaSession.setActionHandler('play', () => {
    // Called from lock screen / Control Center play button.
    // AUDIO.play() alone fails silently if the stream URL expired or iOS
    // dropped the buffer. Try play() first; if it rejects, reload the stream.
    if (AUDIO.src && AUDIO.src !== window.location.href) {
      AUDIO.play().catch(() => {
        if (state.currentTrack) loadStreamForTrack(state.currentTrack);
      });
    } else if (state.currentTrack) {
      loadStreamForTrack(state.currentTrack);
    }
  });
  navigator.mediaSession.setActionHandler('pause', () => {
    AUDIO.pause();
    // Explicitly mark state so visibility-resume logic doesn't fight the
    // user's intentional pause from the lock screen.
    state.playing = false;
  });
  navigator.mediaSession.setActionHandler('previoustrack', () => seekPrev());
  navigator.mediaSession.setActionHandler('nexttrack',     () => seekNext());
  navigator.mediaSession.setActionHandler('seekto', e => { if (state.currentDuration) AUDIO.currentTime = e.seekTime; });
  navigator.mediaSession.setActionHandler('seekbackward', e => { AUDIO.currentTime = Math.max(0, AUDIO.currentTime - (e.seekOffset || 10)); });
  navigator.mediaSession.setActionHandler('seekforward',  e => { AUDIO.currentTime = Math.min(AUDIO.duration || 0, AUDIO.currentTime + (e.seekOffset || 10)); });
}

/* ── HISTORY ── */
function addToHistory(track) {
  state.history = state.history.filter(t => t.videoId !== track.videoId);
  state.history.unshift(track);
  if (state.history.length > 50) state.history = state.history.slice(0, 50);
  save.history();
  renderHomeRecent();
}

/* ── LIKED ── */
function isLiked(videoId) { return state.liked.some(t => t.videoId === videoId); }

function toggleLike(track) {
  if (isLiked(track.videoId)) { state.liked = state.liked.filter(t => t.videoId !== track.videoId); toast('Removed from Liked Songs'); }
  else { state.liked.unshift(track); toast('Added to Liked Songs ♡'); }
  save.liked();
  updateLikeUI(track.videoId);
  renderHomeLiked();
}

function updateLikeUI(videoId) {
  const liked = isLiked(videoId);
  document.querySelectorAll('[data-video-id="' + videoId + '"] .track-like-btn').forEach(b => {
    b.classList.toggle('liked', liked);
    const svg = b.querySelector('svg');
    if (svg) svg.classList.toggle('filled', liked);
  });
  if (state.currentTrack?.videoId === videoId) {
    el('np-heart').classList.toggle('filled', liked);
    el('mini-like-btn').classList.toggle('liked', liked);
  }
}

/* ── PLAYLISTS ── */
function createPlaylist(name) {
  const pl = { id: Date.now().toString(), name, tracks: [] };
  state.playlists.push(pl);
  save.playlists();
  renderLibraryPlaylists();
  renderHomePlaylists();
  toast('Playlist "' + name + '" created');
  return pl;
}

function deletePlaylist(id) {
  state.playlists = state.playlists.filter(p => p.id !== id);
  save.playlists();
  renderLibraryPlaylists();
  renderHomePlaylists();
  closePlaylistDetail();
  toast('Playlist deleted');
}

function addToPlaylist(playlistId, track) {
  const pl = state.playlists.find(p => p.id === playlistId);
  if (!pl) return;
  if (pl.tracks.some(t => t.videoId === track.videoId)) { toast('Already in playlist'); return; }
  pl.tracks.push(track);
  save.playlists();
  renderLibraryPlaylists();
  renderHomePlaylists();
  toast('Added to "' + pl.name + '"');
}

function removeFromPlaylist(playlistId, videoId) {
  const pl = state.playlists.find(p => p.id === playlistId);
  if (!pl) return;
  pl.tracks = pl.tracks.filter(t => t.videoId !== videoId);
  save.playlists();
  openPlaylistDetail(playlistId);
  toast('Removed from playlist');
}

/* ── YOUTUBE SEARCH ── */
async function searchYouTube(query) {
  // Try YouTube Data API first
  const ytUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=20&q=${encodeURIComponent(query)}&key=${state.apiKey}`;
  try {
    const res = await fetch(ytUrl, { signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const data = await res.json();
      const items = data.items || [];
      if (items.length) {
        return items.map(item => ({
          videoId: item.id.videoId,
          title:   decodeHTML(item.snippet.title),
          artist:  decodeHTML(item.snippet.channelTitle),
          thumb:   `https://i.ytimg.com/vi/${item.id.videoId}/mqdefault.jpg`,
        }));
      }
    }
    // If quota hit (403) or empty results, fall through to Invidious
    const errData = res.ok ? null : await res.json().catch(() => ({}));
    if (errData?.error?.code === 403) {
      console.warn('[Search] YouTube API quota hit — using Invidious fallback');
    }
  } catch (e) {
    console.warn('[Search] YouTube API failed:', e.message);
  }
  // Invidious search fallback
  return searchInvidious(query);
}

/* searchInvidious — races all instances in parallel, same strategy as
   resolveAudioUrl. First instance that returns ≥1 result wins. */
async function searchInvidious(query) {
  const outer = new AbortController();
  const instances = instanceHealth.sorted();

  return new Promise(resolve => {
    let settled = false;
    let pending = instances.length;

    instances.forEach(base => {
      const url = `${base}/api/v1/search?q=${encodeURIComponent(query)}&type=video&fields=videoId,title,author,videoThumbnails&page=1`;
      const timeoutSignal = AbortSignal.timeout(5000);
      const combinedSignal = AbortSignal.any
        ? AbortSignal.any([outer.signal, timeoutSignal])
        : timeoutSignal;

      fetch(url, { signal: combinedSignal })
        .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
        .then(data => {
          if (settled) return;
          if (!Array.isArray(data) || !data.length) throw new Error('empty');
          settled = true;
          outer.abort();
          instanceHealth.success(base);
          console.log(`[Invidious Search] ✓ ${base}`);
          resolve(data.slice(0, 20).map(item => ({
            videoId: item.videoId,
            title:   item.title || '',
            artist:  item.author || '',
            // Always use ytimg.com directly — Invidious proxies are blocked by CSP
            thumb:   `https://i.ytimg.com/vi/${item.videoId}/mqdefault.jpg`,
          })));
        })
        .catch(e => {
          if (!outer.signal.aborted) {
            instanceHealth.failure(base);
            console.warn(`[Invidious Search] ✗ ${base}:`, e.message);
          }
          pending--;
          if (pending === 0 && !settled) {
            toast('Search failed — check your connection');
            resolve([]);
          }
        });
    });
  });
}

/* ── FEATURED HOME CONTENT ── */
const GENRES = ['Pop', 'Hip-Hop', 'R&B', 'Electronic', 'Rock', 'Latin', 'K-Pop', 'Jazz'];

const FEATURED_PLAYLISTS = [
  { id: 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI', name: 'Global Top 50', sub: 'Most played worldwide', badge: '🔥 Hot' },
  { id: 'PLDfKAXSB4bFQelB9Fo-JHHSGvVtDhF0En', name: 'Viral Hits 2025', sub: 'Trending right now', badge: '⚡ Viral' },
  { id: 'PLGHe6Moaz52PUNP4DQGzkApo6_RMBRX_T', name: 'Chill Vibes', sub: 'Relax & unwind', badge: '😌 Chill' },
  { id: 'PLMC9KNkIncKtPzgfTss0eKNuld_khjT0M', name: 'Workout Energy', sub: 'Power through it', badge: '💪 Pump' },
  { id: 'PLBSmHJCHYDOhLJTXg-E-HVKV6Fqz2lcN9', name: 'Late Night Drive', sub: 'Mood for the road', badge: '🌙 Night' },
];

const FEATURED_TRACKS_BY_GENRE = {
  'Pop':        'pop hits 2025',
  'Hip-Hop':    'hip hop hits 2025',
  'R&B':        'rnb hits 2025',
  'Electronic': 'electronic dance music 2025',
  'Rock':       'rock hits 2025',
  'Latin':      'latin hits 2025',
  'K-Pop':      'kpop hits 2025',
  'Jazz':       'jazz 2025',
};

const FEATURED_BANNERS = [
  { query: 'Kendrick Lamar 2025', title: 'Kendrick Lamar', sub: 'Latest drops', eyebrow: '🔥 Trending Artist' },
  { query: 'Sabrina Carpenter popular', title: 'Sabrina Carpenter', sub: 'Short n\' Sweet era', eyebrow: '✨ Fan Favorite' },
  { query: 'Billie Eilish 2025', title: 'Billie Eilish', sub: 'HIT ME HARD AND SOFT', eyebrow: '🎵 Must Listen' },
  { query: 'Taylor Swift popular', title: 'Taylor Swift', sub: 'The Eras Tour era', eyebrow: '⭐ Icon' },
];

async function loadFeaturedBanner() {
  const banner = el('featured-banner');
  if (!banner) return;
  const pick = FEATURED_BANNERS[Math.floor(Math.random() * FEATURED_BANNERS.length)];

  let tracks = [];

  // Try YouTube API first
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=3&q=${encodeURIComponent(pick.query)}&key=${state.apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const data = await res.json();
      const items = data.items || [];
      if (items.length) {
        tracks = items.map(i => ({
          videoId: i.id.videoId,
          title: decodeHTML(i.snippet.title),
          artist: decodeHTML(i.snippet.channelTitle),
          // Use ytimg directly — always reliable
          thumb: `https://i.ytimg.com/vi/${i.id.videoId}/mqdefault.jpg`,
        }));
      }
    }
  } catch {}

  // Fallback to Invidious search
  if (!tracks.length) {
    try {
      const inv = await searchInvidious(pick.query);
      tracks = inv.slice(0, 3);
    } catch {}
  }

  if (!tracks.length) { banner.style.display = 'none'; return; }

  const track = tracks[0];
  banner.innerHTML = `
    <div class="featured-card">
      <img src="${esc(track.thumb)}" alt="${esc(track.title)}" />
      <div class="featured-card-overlay">
        <div class="featured-eyebrow">${esc(pick.eyebrow)}</div>
        <div class="featured-title">${esc(pick.title)}</div>
        <div class="featured-sub">${esc(pick.sub)}</div>
      </div>
    </div>`;
  banner.querySelector('.featured-card').addEventListener('click', () => {
    playTrack(track, tracks, 0);
    el('np-queue-name').textContent = pick.title;
    openNowPlaying();
  });
}

async function loadFeaturedPlaylists() {
  const row = el('featured-playlists-row');
  if (!row) return;
  row.innerHTML = '';
  FEATURED_PLAYLISTS.forEach(pl => {
    const card = document.createElement('div');
    card.className = 'featured-pl-card';
    card.innerHTML = `
      <div class="featured-pl-art">
        <img src="https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg" alt="${esc(pl.name)}" data-pl-id="${esc(pl.id)}" />
        <div class="featured-pl-badge">${esc(pl.badge)}</div>
      </div>
      <div class="featured-pl-name">${esc(pl.name)}</div>
      <div class="featured-pl-sub">${esc(pl.sub)}</div>`;
    card.addEventListener('click', () => loadYouTubePlaylist(pl));
    row.appendChild(card);
  });
  // Try to load real thumbnails
  loadFeaturedPlaylistThumbs();
}

async function loadFeaturedPlaylistThumbs() {
  const row = el('featured-playlists-row');
  if (!row) return;

  // Fetch all playlist thumbnails in parallel — no reason to wait for each one
  await Promise.allSettled(FEATURED_PLAYLISTS.map(async (pl, i) => {
    const card = row.children[i];
    if (!card) return;
    const img = card.querySelector('img');
    if (!img) return;

    // Try YouTube API first (fastest when quota is available)
    let thumb = null;
    try {
      const url = `https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${pl.id}&key=${state.apiKey}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        const t = data.items?.[0]?.snippet?.thumbnails;
        thumb = t?.medium?.url || t?.default?.url || null;
      }
    } catch {}

    // Fallback: race Invidious instances for the first video ID in the playlist
    if (!thumb) {
      const outer = new AbortController();
      thumb = await new Promise(resolve => {
        let done = false;
        let pending = INVIDIOUS_INSTANCES.length;
        instanceHealth.sorted().forEach(base => {
          const url = `${base}/api/v1/playlists/${pl.id}?fields=videos`;
          const sig = AbortSignal.timeout(5000);
          fetch(url, { signal: AbortSignal.any ? AbortSignal.any([outer.signal, sig]) : sig })
            .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
            .then(data => {
              const firstId = data?.videos?.[0]?.videoId;
              if (firstId && !done) {
                done = true;
                outer.abort();
                resolve(`https://i.ytimg.com/vi/${firstId}/mqdefault.jpg`);
              } else {
                pending--;
                if (pending === 0 && !done) resolve(null);
              }
            })
            .catch(() => {
              pending--;
              if (pending === 0 && !done) resolve(null);
            });
        });
      });
    }

    if (thumb) img.src = thumb;
  }));
}

async function loadYouTubePlaylist(pl) {
  toast('Loading ' + pl.name + '…');
  try {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=20&playlistId=${pl.id}&key=${state.apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('API error');
    const data = await res.json();
    const tracks = (data.items || [])
      .filter(i => i.snippet?.resourceId?.videoId)
      .map(i => ({
        videoId: i.snippet.resourceId.videoId,
        title:   decodeHTML(i.snippet.title),
        artist:  decodeHTML(i.snippet.videoOwnerChannelTitle || i.snippet.channelTitle),
        thumb:   `https://i.ytimg.com/vi/${i.snippet.resourceId.videoId}/mqdefault.jpg`,
      }));
    if (!tracks.length) { toast('Empty playlist'); return; }
    playTrack(tracks[0], tracks, 0);
    el('np-queue-name').textContent = pl.name;
    openNowPlaying();
  } catch { toast('Could not load playlist'); }
}

async function loadTrendingByGenre(genre) {
  state.currentGenre = genre;
  // Update pills
  document.querySelectorAll('.genre-pill').forEach(p => p.classList.toggle('active', p.textContent === genre));
  const row = el('trending-row');
  if (!row) return;
  row.innerHTML = '<div class="trending-shimmer-row"><div class="track-shimmer"></div><div class="track-shimmer"></div><div class="track-shimmer"></div></div>';
  const query = FEATURED_TRACKS_BY_GENRE[genre] || genre + ' hits 2025';
  const results = await searchYouTube(query);
  row.innerHTML = '';
  if (!results.length) { row.innerHTML = '<div class="empty-state-small" style="padding:8px 0">No results</div>'; return; }
  const top = results.slice(0, 6);
  top.forEach((t, i) => {
    const item = buildTrackItem(t, { queue: top, idx: i, context: genre });
    row.appendChild(item);
  });
}

function setupGenrePills() {
  const container = el('genre-pills');
  if (!container) return;
  GENRES.forEach(g => {
    const btn = document.createElement('button');
    btn.className = 'genre-pill' + (g === state.currentGenre ? ' active' : '');
    btn.textContent = g;
    btn.addEventListener('click', () => loadTrendingByGenre(g));
    container.appendChild(btn);
  });
}

/* ── ART COLOR EXTRACTION ── */
function updateArtColor(thumbUrl) {
  if (!thumbUrl) return;
  const img = new Image();
  img.onload = function () {
    try {
      const c = document.createElement('canvas'); c.width = 40; c.height = 40;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, 40, 40);
      const d = ctx.getImageData(0, 0, 40, 40).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 16) { r += d[i]; g += d[i+1]; b += d[i+2]; n++; }
      const color = `rgb(${Math.round(r/n)},${Math.round(g/n)},${Math.round(b/n)})`;
      el('sheet-bg-blur').style.setProperty('--art-color', color);
      el('np-glow').style.setProperty('--art-color', color);
    } catch {}
  };
  img.src = thumbUrl;
}

/* ── UI HELPERS ── */
const el = id => document.getElementById(id);
const artContainer = document.getElementById('np-art-container');

function updateNowPlaying(track) {
  el('np-title').textContent  = track.title;
  el('np-artist').textContent = track.artist;
  el('np-art').src            = track.thumb;
  el('np-heart').classList.toggle('filled', isLiked(track.videoId));
  artContainer.classList.remove('playing');
  artContainer.classList.add('paused');
}

function updateMiniPlayer(track) {
  el('mini-title').textContent  = track.title;
  el('mini-artist').textContent = track.artist;
  el('mini-art-img').src        = track.thumb;
  el('mini-like-btn').classList.toggle('liked', isLiked(track.videoId));
  el('mini-player').classList.remove('hidden');
}

function updatePlayIcons(playing) {
  const ppPlay = el('pp-play'), ppPause = el('pp-pause');
  if (!ppPlay) return;
  ppPlay.style.display  = playing ? 'none' : '';
  ppPause.style.display = playing ? '' : 'none';
  const miniIcon = el('mini-play-icon');
  if (miniIcon) {
    miniIcon.innerHTML = playing
      ? '<path d="M6 19h4V5H6zm8-14v14h4V5z"/>'
      : '<path d="M8 5v14l11-7z"/>';
  }
}

/* ── REPEAT ICON ── */
function updateRepeatIcon() {
  const btn = el('np-repeat');
  if (!btn) return;
  btn.classList.toggle('active', state.repeat !== 'none');
  // Show a small "1" overlay badge when repeat-one is active
  let badge = btn.querySelector('.repeat-one-badge');
  if (state.repeat === 'one') {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'repeat-one-badge';
      badge.textContent = '1';
      badge.style.cssText = 'position:absolute;top:0;right:0;font-size:9px;font-weight:700;line-height:1;color:var(--accent,#1DB954);pointer-events:none;';
      btn.style.position = 'relative';
      btn.appendChild(badge);
    }
  } else {
    if (badge) badge.remove();
  }
}

/* ── PAGE NAVIGATION ── */
function switchPage(pageId) {
  const pages = document.querySelectorAll('.page');

  // Fully reset every page that isn't the target — clear ALL class/style state
  // so stale transitions never leave a page blocking touches.
  pages.forEach(p => {
    if (p.id !== pageId) {
      p.classList.remove('active', 'prev');
      p.style.display = 'none';
      p.style.pointerEvents = 'none';
    }
  });

  const next = el(pageId);
  if (next) {
    next.style.display = 'flex';
    next.style.pointerEvents = '';
    // Force reflow so the transition fires correctly
    next.offsetHeight;
    next.classList.add('active');
  }

  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === pageId));
  const titles = { 'page-home':'Listen Now', 'page-search':'Search', 'page-library':'Library', 'page-settings':'Settings' };
  el('page-title').textContent = titles[pageId] || '';
  if (pageId === 'page-library') renderLibrary();
  if (pageId === 'page-home')    renderHome();
}

function openNowPlaying()  { el('now-playing-sheet').classList.remove('hidden'); }
function closeNowPlaying() { el('now-playing-sheet').classList.add('hidden'); }

/* ── PLAYLIST DETAIL ── */
function openPlaylistDetail(id) {
  state.currentPlaylistId = id;
  const pl = state.playlists.find(p => p.id === id);
  if (!pl) return;
  el('pl-detail-name').textContent  = pl.name;
  el('pl-detail-title').textContent = pl.name;
  el('pl-detail-count').textContent = pl.tracks.length + ' song' + (pl.tracks.length !== 1 ? 's' : '');
  const grid = el('pl-art-grid');
  grid.innerHTML = '';
  const thumbs = pl.tracks.slice(0, 4).map(t => t.thumb).filter(Boolean);
  grid.classList.toggle('single', thumbs.length <= 1);
  thumbs.forEach(src => { const img = new Image(); img.src = src; grid.appendChild(img); });
  const list = el('pl-track-list');
  list.innerHTML = '';
  if (!pl.tracks.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">🎵</div><p>Empty playlist</p><span>Search for songs and add them here</span></div>';
  } else {
    pl.tracks.forEach((t, i) => list.appendChild(buildTrackItem(t, { queue: pl.tracks, idx: i, context: pl.name, onRemove: () => removeFromPlaylist(id, t.videoId) })));
  }
  el('playlist-detail').classList.remove('hidden');
}

function closePlaylistDetail() { el('playlist-detail').classList.add('hidden'); state.currentPlaylistId = null; }

/* ── TRACK ITEM BUILDER ── */
function buildTrackItem(track, opts = {}) {
  const div = document.createElement('div');
  div.className = 'track-item' + (state.currentTrack?.videoId === track.videoId ? ' playing' : '');
  div.dataset.videoId = track.videoId;
  const liked = isLiked(track.videoId);
  div.innerHTML = `
    <div class="track-thumb">
      <img src="${esc(track.thumb)}" alt="" loading="lazy"/>
      <div class="playing-indicator"><div class="bars"><div class="bar"></div><div class="bar"></div><div class="bar"></div></div></div>
    </div>
    <div class="track-info">
      <div class="track-title">${esc(track.title)}</div>
      <div class="track-artist">${esc(track.artist)}</div>
    </div>
    <div class="track-actions">
      <button class="icon-btn track-like-btn ${liked ? 'liked' : ''}" aria-label="Like">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" class="${liked ? 'filled' : ''}">
          <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
        </svg>
      </button>
      <button class="icon-btn track-more-btn" aria-label="More">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
      </button>
    </div>`;
  div.querySelector('.track-thumb').addEventListener('click', () => {
    const queue = opts.queue || [track];
    const idx   = opts.idx ?? 0;
    state.queue    = queue;
    state.queueIdx = idx;
    if (opts.context) el('np-queue-name').textContent = opts.context;
    playTrack(track);
    openNowPlaying();
  });
  div.querySelector('.track-like-btn').addEventListener('click', e => { e.stopPropagation(); toggleLike(track); });
  div.querySelector('.track-more-btn').addEventListener('click', e => { e.stopPropagation(); showTrackMenu(track, opts.onRemove); });
  return div;
}

/* ── TRACK CONTEXT MENU ── */
function showTrackMenu(track, onRemove) {
  document.getElementById('track-menu')?.remove();
  document.getElementById('track-menu-overlay')?.remove();
  ensureSlideUpStyle();
  const menu = document.createElement('div');
  menu.id = 'track-menu';
  menu.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:150;background:var(--card);border-radius:var(--sheet-radius) var(--sheet-radius) 0 0;padding:8px 0 calc(env(safe-area-inset-bottom,0px) + 16px);animation:slideUp .3s cubic-bezier(.32,0,.04,1)';
  const items = [
    { icon: '♡', label: isLiked(track.videoId) ? 'Remove from Liked' : 'Add to Liked', action: () => toggleLike(track) },
    { icon: '＋', label: 'Add to Playlist', action: () => openAddToPlaylist(track) },
  ];
  if (onRemove) items.push({ icon: '✕', label: 'Remove from Playlist', action: onRemove, danger: true });
  items.forEach(item => {
    const btn = document.createElement('button');
    btn.style.cssText = `width:100%;display:flex;align-items:center;gap:16px;padding:16px 24px;font-size:17px;font-weight:500;color:${item.danger?'#ff453a':'var(--text)'};background:none;border:none;text-align:left;`;
    btn.innerHTML = `<span style="font-size:20px;width:28px;text-align:center">${item.icon}</span><span>${item.label}</span>`;
    btn.addEventListener('click', () => { item.action(); cleanup(); });
    menu.appendChild(btn);
  });
  const cancel = document.createElement('button');
  cancel.style.cssText = 'width:calc(100% - 32px);margin:8px 16px 0;padding:16px;background:var(--card2);border-radius:var(--radius);font-size:17px;font-weight:600;color:var(--text);';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', cleanup);
  menu.appendChild(cancel);
  const overlay = document.createElement('div');
  overlay.id = 'track-menu-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:149;background:rgba(0,0,0,.5);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);';
  overlay.addEventListener('click', cleanup);
  function cleanup() { menu.remove(); overlay.remove(); }
  document.body.appendChild(overlay);
  document.body.appendChild(menu);
}

function ensureSlideUpStyle() {
  if (!document.getElementById('slide-up-style')) {
    const s = document.createElement('style');
    s.id = 'slide-up-style';
    s.textContent = '@keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}';
    document.head.appendChild(s);
  }
}

/* ── ADD TO PLAYLIST MODAL ── */
function openAddToPlaylist(track) {
  const picker = el('playlist-picker');
  picker.innerHTML = '';
  if (!state.playlists.length) {
    picker.innerHTML = '<div style="padding:12px;color:var(--text2);font-size:14px;text-align:center">No playlists yet. Create one in the Library tab.</div>';
  } else {
    state.playlists.forEach(pl => {
      const div = document.createElement('div');
      div.className = 'playlist-pick-item';
      div.innerHTML = `<img src="${esc(pl.tracks[0]?.thumb || '')}" alt=""/><span>${esc(pl.name)}</span>`;
      div.addEventListener('click', () => { addToPlaylist(pl.id, track); closeModal('modal-add-to-playlist'); });
      picker.appendChild(div);
    });
  }
  el('modal-add-to-playlist').classList.remove('hidden');
}

function closeModal(id) { el(id)?.classList.add('hidden'); }

/* ── RENDER FUNCTIONS ── */
function renderHome() { renderHomeRecent(); renderHomePlaylists(); renderHomeLiked(); setGreeting(); }

function setGreeting() {
  const h = new Date().getHours();
  el('greeting-text').textContent = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function renderHomeRecent() {
  const grid = el('recent-grid');
  grid.innerHTML = '';
  if (!state.history.length) { grid.innerHTML = '<div class="empty-state-small">Start searching to build your history</div>'; return; }
  state.history.slice(0, 6).forEach((track, i) => {
    const div = document.createElement('div');
    div.className = 'recent-item';
    div.innerHTML = `<img src="${esc(track.thumb)}" alt=""/><span>${esc(track.title)}</span>`;
    div.addEventListener('click', () => { playTrack(track, [track], 0); openNowPlaying(); });
    grid.appendChild(div);
  });
}

function renderHomePlaylists() {
  const row = el('home-playlists');
  row.innerHTML = '';
  if (!state.playlists.length) { row.innerHTML = '<div class="empty-state-small">No playlists yet</div>'; return; }
  state.playlists.forEach(pl => {
    const div = document.createElement('div');
    div.className = 'home-pl-card';
    const thumbs = pl.tracks.slice(0, 4).map(t => t.thumb).filter(Boolean);
    div.innerHTML = `<div class="home-pl-art ${thumbs.length<=1?'single':''}">${thumbs.map(s=>`<img src="${esc(s)}" alt=""/>`).join('')}</div><div class="home-pl-name">${esc(pl.name)}</div><div class="home-pl-count">${pl.tracks.length} song${pl.tracks.length!==1?'s':''}</div>`;
    div.addEventListener('click', () => openPlaylistDetail(pl.id));
    row.appendChild(div);
  });
}

function renderHomeLiked() {
  const row = el('home-liked');
  row.innerHTML = '';
  if (!state.liked.length) { row.innerHTML = '<div class="empty-state-small">Like songs to see them here</div>'; return; }
  state.liked.slice(0, 8).forEach((track, i) => {
    const div = document.createElement('div');
    div.className = 'recent-item';
    div.innerHTML = `<img src="${esc(track.thumb)}" alt=""/><span>${esc(track.title)}</span>`;
    div.addEventListener('click', () => { playTrack(track, state.liked, i); openNowPlaying(); });
    row.appendChild(div);
  });
}

function renderLibrary() { renderLibraryPlaylists(); renderLibraryLiked(); renderLibraryHistory(); }

function renderLibraryPlaylists() {
  const list = el('playlist-list'), empty = el('empty-playlists');
  list.innerHTML = '';
  if (!state.playlists.length) { empty.style.display = ''; return; }
  empty.style.display = 'none';
  state.playlists.forEach(pl => {
    const div = document.createElement('div');
    div.className = 'track-item';
    div.innerHTML = `<div class="track-thumb"><img src="${esc(pl.tracks[0]?.thumb||'')}" alt=""/></div><div class="track-info"><div class="track-title">${esc(pl.name)}</div><div class="track-artist">${pl.tracks.length} songs</div></div>`;
    div.addEventListener('click', () => openPlaylistDetail(pl.id));
    list.appendChild(div);
  });
}

function renderLibraryLiked() {
  const list = el('liked-list'), empty = el('empty-liked');
  list.innerHTML = '';
  if (!state.liked.length) { empty.style.display = ''; return; }
  empty.style.display = 'none';
  state.liked.forEach((t, i) => list.appendChild(buildTrackItem(t, { queue: state.liked, idx: i, context: 'Liked Songs' })));
}

function renderLibraryHistory() {
  const list = el('history-list'), empty = el('empty-history');
  list.innerHTML = '';
  if (!state.history.length) { empty.style.display = ''; return; }
  empty.style.display = 'none';
  state.history.forEach((t, i) => list.appendChild(buildTrackItem(t, { queue: state.history, idx: i, context: 'History' })));
}

function renderSearchResults(tracks) {
  const list = el('search-results'), empty = el('search-empty');
  list.innerHTML = '';
  if (!tracks?.length) { empty.style.display = ''; return; }
  empty.style.display = 'none';
  tracks.forEach((t, i) => list.appendChild(buildTrackItem(t, { queue: tracks, idx: i, context: 'Search' })));
}

/* ── SEARCH ── */
let searchDebounce = null;
function handleSearch(query) {
  clearTimeout(searchDebounce);
  el('search-clear').style.display = query ? 'flex' : 'none';
  if (!query.trim()) { el('search-results').innerHTML = ''; el('search-empty').style.display = ''; return; }
  searchDebounce = setTimeout(async () => {
    el('search-empty').style.display = 'none';
    el('search-results').innerHTML = '<div class="empty-state"><div class="empty-icon" style="animation:spin 1s linear infinite;display:inline-block">⟳</div></div>';
    ensureSpinStyle();
    const results = await searchYouTube(query);
    renderSearchResults(results);
  }, 280);
}

function ensureSpinStyle() {
  if (!document.getElementById('spin-style')) {
    const s = document.createElement('style');
    s.id = 'spin-style';
    s.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(s);
  }
}

/* ── TOAST ── */
function toast(msg, dur = 2200) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.classList.add('hidden'), 300); }, dur);
}

/* ── UTILS ── */
function fmtTime(s) {
  if (!s || isNaN(s) || !isFinite(s) || s < 0) return '0:00';
  return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}
function esc(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function decodeHTML(str) {
  const t = document.createElement('textarea'); t.innerHTML = str; return t.value;
}

/* ── iOS BACKGROUND AUDIO KEEP-ALIVE ── */
//
// The problem in full:
//
//   iOS gives a PWA's WebKit process a background audio "assertion" — a
//   system-level token that lets JS keep running and lets the audio element
//   actually produce sound while the screen is locked. This assertion is
//   tied to the existence of an ACTIVE audio session. When you pause
//   AUDIO and leave it paused for ~30 seconds with no audio activity at
//   all, iOS decides the session is idle and terminates the assertion.
//
//   After that happens, AUDIO.play() is accepted without throwing — no
//   error, no rejection — but produces no audio output. The lock-screen
//   scrubber animates because iOS is moving it based on the last-known
//   position, not actual playback. The audio device is simply gone.
//   Opening the app brings it back because foreground apps always have a
//   fresh audio session.
//
//   This is a documented WebKit/iOS limitation (WebKit bug #261858,
//   Apple Developer Forums thread 762582) that Apple has not fixed as of
//   iOS 18. It only affects PWAs in standalone mode, not Safari tabs.
//
// The fix — silent AudioContext keepalive:
//
//   We create an AudioContext with a ConstantSourceNode connected through
//   a GainNode set to gain=0 (zero amplitude — completely inaudible).
//   While AUDIO is paused, we start() this source so the AudioContext
//   keeps ticking. iOS sees an active audio session and keeps the
//   background assertion alive indefinitely.
//
//   When AUDIO resumes, we stop the keepalive (AudioContext CPU is
//   negligible but there's no point running both simultaneously).
//
//   The AudioContext must be created in a user-gesture handler — we do
//   it lazily on the first play() call, which is always user-initiated.
//
// Why ConstantSourceNode and not OscillatorNode:
//   ConstantSourceNode with offset=0 and gain=0 produces a true DC
//   signal at zero amplitude. It's purpose-built for exactly this use
//   case and burns less CPU than OscillatorNode.

let _silentCtx    = null;
let _silentSource = null;
let _silentGain   = null;

function ensureSilentContext() {
  if (_silentCtx) return;
  try {
    _silentCtx  = new (window.AudioContext || window.webkitAudioContext)();
    _silentGain = _silentCtx.createGain();
    _silentGain.gain.value = 0; // completely inaudible
    _silentGain.connect(_silentCtx.destination);
  } catch (e) {
    console.warn('[KeepAlive] AudioContext unavailable:', e.message);
  }
}

function startSilentKeepAlive() {
  if (!_silentCtx) return;
  stopSilentKeepAlive(); // stop any existing source first
  try {
    if (_silentCtx.state === 'suspended') _silentCtx.resume().catch(() => {});
    _silentSource = _silentCtx.createConstantSource();
    _silentSource.offset.value = 0;
    _silentSource.connect(_silentGain);
    _silentSource.start();
    console.log('[KeepAlive] Silent keepalive started');
  } catch (e) {
    console.warn('[KeepAlive] start failed:', e.message);
  }
}

function stopSilentKeepAlive() {
  if (_silentSource) {
    try { _silentSource.stop(); } catch {}
    try { _silentSource.disconnect(); } catch {}
    _silentSource = null;
    console.log('[KeepAlive] Silent keepalive stopped');
  }
}

// Hook into AUDIO events: keepalive runs while paused, stops while playing.
// The ensureSilentContext() call on 'play' is safe because play() is always
// triggered by a user gesture (tap), satisfying iOS's AudioContext policy.
AUDIO.addEventListener('play', () => {
  ensureSilentContext();
  stopSilentKeepAlive();
});
AUDIO.addEventListener('pause',  () => { startSilentKeepAlive(); });
AUDIO.addEventListener('ended',  () => { startSilentKeepAlive(); });

// ── VISIBILITY CHANGE ──
// With the keepalive active, the audio session stays alive during pause,
// so lock-screen play works. The handler below handles the case where iOS
// DID kill the session (e.g. after an interruption like a phone call) by
// attempting a play() with stream-reload fallback on foreground.

let _wasPlayingBeforeHide = false;
let _resumeTimer = null;

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    _wasPlayingBeforeHide = state.playing && !AUDIO.paused;
    if (_resumeTimer) { clearTimeout(_resumeTimer); _resumeTimer = null; }
    return;
  }

  if (_resumeTimer) clearTimeout(_resumeTimer);
  _resumeTimer = setTimeout(() => {
    _resumeTimer = null;

    // Re-register mediaSession so the lock-screen widget re-appears
    if ('mediaSession' in navigator && state.currentTrack) {
      setupMediaSession(state.currentTrack);
      if (state.playing) navigator.mediaSession.playbackState = 'playing';
    }

    // Resume AudioContext if iOS suspended it during an interruption
    if (_silentCtx && _silentCtx.state === 'suspended') {
      _silentCtx.resume().catch(() => {});
    }

    // If we were playing when we left and iOS paused us, try to resume
    if (_wasPlayingBeforeHide && state.playing && AUDIO.paused) {
      AUDIO.play().catch(err => {
        console.warn('[BG resume] play() rejected:', err.message, '— reloading stream');
        if (state.currentTrack) loadStreamForTrack(state.currentTrack);
      });
    }

    _wasPlayingBeforeHide = false;
  }, 600); // 600 ms — iOS needs ~500 ms to settle AVAudioSession
});

/* ── SWIPE DOWN TO CLOSE NOW PLAYING ── */
(function setupSwipe() {
  const sheet = document.getElementById('now-playing-sheet');
  let startY = 0, curY = 0, dragging = false;
  sheet.addEventListener('touchstart', e => { startY = e.touches[0].clientY; dragging = true; }, { passive: true });
  sheet.addEventListener('touchmove', e => {
    if (!dragging) return;
    curY = e.touches[0].clientY;
    const dy = curY - startY;
    if (dy > 0) { sheet.style.transform = `translateY(${dy}px)`; sheet.style.transition = 'none'; }
  }, { passive: true });
  sheet.addEventListener('touchend', () => {
    dragging = false;
    const dy = curY - startY;
    sheet.style.transition = '';
    sheet.style.transform  = '';
    if (dy > 100) closeNowPlaying();
    startY = 0; curY = 0;
  });
})();

/* ── PREVENT HORIZONTAL PAGE SCROLL ON SLIDER DRAG ── */
// All horizontal scroll should only happen in intentional scrolling containers
// We block horizontal touchmove at the document level except in designated areas
(function preventHorizontalPageScroll() {
  let startX = 0, startY = 0;
  document.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    // Allow scroll in designated horizontal scroll areas
    const target = e.target;
    const inHScroll = target.closest('.playlist-row, .liked-row, .genre-pills, .trending-row, #featured-playlists-row');
    if (inHScroll) return; // let it scroll

    // In the now-playing sheet, allow only vertical or progress drag
    const inProgressTrack = target.closest('#progress-track, #volume-track');
    if (inProgressTrack) return; // handled by slider logic

    const dx = Math.abs(e.touches[0].clientX - startX);
    const dy = Math.abs(e.touches[0].clientY - startY);

    // Block horizontal movement that's clearly horizontal (not diagonal)
    if (dx > dy && dx > 8) {
      e.preventDefault();
    }
  }, { passive: false });
})();

/* ════════════════════════════════════════════════════
   EVENT LISTENERS
   ════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  renderHome();
  setupGenrePills();
  loadFeaturedBanner();
  loadFeaturedPlaylists();
  loadTrendingByGenre(state.currentGenre);
  setupCustomSliders();

  updatePlayIcons(false);

  /* Bottom nav */
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchPage(btn.dataset.page));
  });

  /* Library tabs */
  document.querySelectorAll('.lib-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.lib-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const w = tab.dataset.tab;
      el('lib-playlists').style.display = w === 'playlists' ? '' : 'none';
      el('lib-liked').style.display     = w === 'liked'     ? '' : 'none';
      el('lib-history').style.display   = w === 'history'   ? '' : 'none';
      if (w === 'liked')   renderLibraryLiked();
      if (w === 'history') renderLibraryHistory();
    });
  });

  /* Search */
  el('search-input').addEventListener('input',  e => handleSearch(e.target.value));
  el('search-input').addEventListener('focus',  () => switchPage('page-search'));
  el('search-clear').addEventListener('click',  () => {
    el('search-input').value = '';
    el('search-results').innerHTML = '';
    el('search-empty').style.display = '';
    el('search-clear').style.display = 'none';
  });
  el('search-cancel').addEventListener('click', () => {
    el('search-input').value = '';
    el('search-results').innerHTML = '';
    el('search-empty').style.display = '';
    el('search-clear').style.display = 'none';
    el('search-input').blur();
    switchPage('page-home');
  });
  el('btn-search-top').addEventListener('click', () => {
    switchPage('page-search');
    setTimeout(() => el('search-input').focus(), 100);
  });

  /* Mini player */
  el('mini-player').addEventListener('click', e => { if (!e.target.closest('button')) openNowPlaying(); });
  el('mini-play-btn').addEventListener('click', e => { e.stopPropagation(); togglePlayPause(); });
  el('mini-next-btn').addEventListener('click', e => { e.stopPropagation(); seekNext(); });
  el('mini-like-btn').addEventListener('click', e => { e.stopPropagation(); if (state.currentTrack) toggleLike(state.currentTrack); });

  /* Now Playing */
  el('np-close').addEventListener('click', closeNowPlaying);
  el('np-play').addEventListener('click',  togglePlayPause);
  el('np-prev').addEventListener('click',  seekPrev);
  el('np-next').addEventListener('click',  seekNext);
  el('np-like-btn').addEventListener('click', () => { if (state.currentTrack) toggleLike(state.currentTrack); });
  el('np-add-to-playlist').addEventListener('click', () => { if (state.currentTrack) openAddToPlaylist(state.currentTrack); });
  el('np-more').addEventListener('click', () => { if (state.currentTrack) showTrackMenu(state.currentTrack); });
  el('np-airplay').addEventListener('click', () => toast('Use AirPlay from Control Center'));

  el('np-shuffle').addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    el('np-shuffle').classList.toggle('active', state.shuffle);
    toast(state.shuffle ? 'Shuffle on' : 'Shuffle off');
  });

  el('np-repeat').addEventListener('click', () => {
    const modes = ['none','all','one'];
    state.repeat = modes[(modes.indexOf(state.repeat) + 1) % 3];
    updateRepeatIcon();
    toast({ none:'Repeat off', all:'Repeat all', one:'Repeat one' }[state.repeat]);
  });

  /* Playlists */
  el('btn-new-playlist').addEventListener('click', () => el('modal-new-playlist').classList.remove('hidden'));
  el('modal-pl-cancel').addEventListener('click',  () => closeModal('modal-new-playlist'));
  el('modal-pl-create').addEventListener('click',  () => {
    const name = el('playlist-name-input').value.trim();
    if (name) { createPlaylist(name); el('playlist-name-input').value = ''; closeModal('modal-new-playlist'); }
  });
  el('playlist-name-input').addEventListener('keydown', e => { if (e.key === 'Enter') el('modal-pl-create').click(); });
  el('modal-atp-cancel').addEventListener('click', () => closeModal('modal-add-to-playlist'));

  /* Playlist detail */
  el('pl-back').addEventListener('click', closePlaylistDetail);
  el('pl-delete').addEventListener('click', () => {
    if (state.currentPlaylistId && confirm('Delete this playlist?')) deletePlaylist(state.currentPlaylistId);
  });
  el('pl-play-all').addEventListener('click', () => {
    const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
    if (pl?.tracks.length) { playTrack(pl.tracks[0], pl.tracks, 0); el('np-queue-name').textContent = pl.name; openNowPlaying(); }
    else toast('No songs in playlist');
  });
  el('pl-shuffle-all').addEventListener('click', () => {
    const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
    if (pl?.tracks.length) {
      state.shuffle = true; el('np-shuffle').classList.add('active');
      const idx = Math.floor(Math.random() * pl.tracks.length);
      playTrack(pl.tracks[idx], pl.tracks, idx);
      el('np-queue-name').textContent = pl.name; openNowPlaying();
    } else toast('No songs in playlist');
  });

  /* Settings */
  el('btn-clear-data').addEventListener('click', () => {
    if (confirm('Clear all data? Playlists, liked songs, and history will be removed.')) {
      ['playlists','liked','history','volume'].forEach(k => localStorage.removeItem('aspoti_' + k));
      location.reload();
    }
  });
  el('toggle-bg-audio').checked = true;

  /* Modal backdrop close */
  document.querySelectorAll('.modal-overlay').forEach(m => {
    m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); });
  });
});

/* ── SERVICE WORKER ── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

/* ── NAVIGATION GUARD ──
   Intercepts any accidental <a href> clicks or programmatic navigations that
   would take the user outside the PWA shell. Without this, external URLs open
   in Safari (showing the URL bar + the "dangerous site" interstitial if the
   destination is on Google's Safe Browsing list). All external content is
   loaded via fetch() instead — this guard is a safety net.
── */
document.addEventListener('click', e => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  // Allow same-origin anchor links (e.g. #section)
  if (!href || href.startsWith('#')) return;
  try {
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) {
      e.preventDefault();
      console.warn('[Nav Guard] Blocked external navigation to:', url.href);
    }
  } catch {}
}, true);

// Also block window.open calls that might fire from third-party scripts
const _windowOpen = window.open.bind(window);
window.open = function(url, ...args) {
  if (url && typeof url === 'string') {
    try {
      const parsed = new URL(url, window.location.href);
      if (parsed.origin !== window.location.origin) {
        console.warn('[Nav Guard] Blocked window.open to:', url);
        return null;
      }
    } catch {}
  }
  return _windowOpen(url, ...args);
};
