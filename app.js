/* ═══════════════════════════════════════════════════
   ASPOTÏ · app.js  — v2 (Native Audio Engine)
   Uses Piped/Invidious public APIs to get a direct
   audio stream URL → feeds a real <audio> element.
   This means iOS background + lock screen playback
   works natively with no native app required.
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
  repeat:           'none', // 'none' | 'all' | 'one'
  playing:          false,
  loading:          false,
  currentTrack:     null,
  currentDuration:  0,
  volumeLevel:      DB.get('volume', 80),
  currentPlaylistId: null,
};

const save = {
  playlists() { DB.set('playlists', state.playlists); },
  liked()     { DB.set('liked',     state.liked);     },
  history()   { DB.set('history',   state.history);   },
  volume()    { DB.set('volume',    state.volumeLevel); },
};

/* ════════════════════════════════════════════════════
   NATIVE AUDIO ENGINE
   Priority: Piped instances → Invidious instances
   Falls back through list until one works.
   The <audio> element is a first-class browser citizen
   so iOS respects it for lock screen + background play.
   ════════════════════════════════════════════════════ */

// ── InnerTube (YouTube's internal API) — primary source, same as ytify ──
// The ANDROID client returns plain URLs (no signature cipher needed) and
// works reliably across regions. Key is public and non-rotating.
const INNERTUBE_KEY = 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w';
const INNERTUBE_URL = `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`;

// Piped/Invidious kept as fallback (they may or may not work depending on instance health)
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.projectsegfau.lt',
  'https://pipedapi.moomoo.me',
  'https://pa.il.ax',
];

const INVIDIOUS_INSTANCES = [
  'https://yewtu.be',
  'https://invidious.nerdvpn.de',
  'https://inv.nadeko.net',
  'https://invidious.privacyredirect.com',
];

// The single native audio element — this is what iOS respects
const AUDIO = new Audio();
AUDIO.preload = 'none';
// NOTE: Do NOT set crossOrigin = 'anonymous' — on iOS it breaks background audio
// by triggering a CORS preflight that the stream CDN doesn't satisfy, killing the
// media session assertion needed for lock-screen / background playback.
AUDIO.setAttribute('playsinline', '');

// Wire up audio events
AUDIO.addEventListener('play',    () => onAudioPlay());
AUDIO.addEventListener('pause',   () => onAudioPause());
AUDIO.addEventListener('ended',   () => onAudioEnded());
AUDIO.addEventListener('error',   () => onAudioError());
AUDIO.addEventListener('waiting', () => showLoadingState(true));
AUDIO.addEventListener('canplay', () => showLoadingState(false));
AUDIO.addEventListener('loadedmetadata', () => {
  state.currentDuration = AUDIO.duration || 0;
});

function onAudioPlay() {
  state.playing = true;
  state.loading = false;
  showLoadingState(false);
  updatePlayIcons(true);
  artContainer.classList.add('playing');
  artContainer.classList.remove('paused');
  startProgressLoop();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
}

function onAudioPause() {
  state.playing = false;
  updatePlayIcons(false);
  artContainer.classList.remove('playing');
  artContainer.classList.add('paused');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
}

function onAudioEnded() {
  state.playing = false;
  if (state.repeat === 'one') { AUDIO.currentTime = 0; AUDIO.play().catch(() => {}); }
  else seekNext();
}

function onAudioError() {
  console.warn('Audio element error — stream URL may have expired or be unsupported');
  showLoadingState(false);
  if (state.currentTrack) {
    toast('Stream error — retrying...');
    setTimeout(() => loadStreamForTrack(state.currentTrack), 1000);
  }
}

/* ── STREAM RESOLUTION ── */

// PRIMARY: YouTube InnerTube /youtubei/v1/player with ANDROID client
// This is the same method ytify uses. The ANDROID client returns plain,
// ready-to-use stream URLs with no signature deciphering required.
async function resolveViaInnertube(videoId) {
  try {
    const res = await fetch(INNERTUBE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: 'ANDROID',
            clientVersion: '19.09.37',
            androidSdkVersion: 30,
            userAgent: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
            hl: 'en',
            gl: 'US',
          },
        },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.playabilityStatus?.status !== 'OK') {
      throw new Error(`Not playable: ${data.playabilityStatus?.reason || data.playabilityStatus?.status}`);
    }

    const adaptiveFormats = data.streamingData?.adaptiveFormats || [];
    // Audio-only streams (no width/height)
    const audioFormats = adaptiveFormats.filter(f =>
      f.mimeType?.startsWith('audio/') && !f.width
    );
    if (!audioFormats.length) throw new Error('no audio streams in InnerTube response');

    // Prefer M4A (audio/mp4) for maximum iOS compatibility, then any audio
    const m4a = audioFormats.filter(f => f.mimeType?.includes('audio/mp4'));
    const pool = m4a.length ? m4a : audioFormats;
    // Sort by bitrate descending, pick highest quality
    pool.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const chosen = pool[0];
    console.log(`[InnerTube] Got stream: ${chosen.mimeType} @ ${chosen.bitrate}bps`);
    return chosen.url;
  } catch (e) {
    console.warn('[InnerTube] Failed:', e.message);
    return null;
  }
}

// FALLBACK A: Piped instances
async function resolveViaPiped(videoId, attempt = 0) {
  if (attempt >= PIPED_INSTANCES.length) return null;
  const base = PIPED_INSTANCES[attempt];
  try {
    const res = await fetch(`${base}/streams/${videoId}`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const streams = (data.audioStreams || []).filter(s => !s.videoOnly);
    if (!streams.length) throw new Error('no audio streams');
    // Prefer m4a/mp4 for iOS, then opus
    const m4a = streams.filter(s => s.mimeType?.includes('audio/mp4') || s.codec?.includes('mp4a'));
    const pool = m4a.length ? m4a : streams;
    pool.sort((a, b) => b.bitrate - a.bitrate);
    return pool[0].url;
  } catch (e) {
    console.warn(`[Piped] ${base} failed:`, e.message);
    return resolveViaPiped(videoId, attempt + 1);
  }
}

// FALLBACK B: Invidious instances
async function resolveViaInvidious(videoId, attempt = 0) {
  if (attempt >= INVIDIOUS_INSTANCES.length) return null;
  const base = INVIDIOUS_INSTANCES[attempt];
  try {
    const res = await fetch(`${base}/api/v1/videos/${videoId}?fields=adaptiveFormats`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const formats = (data.adaptiveFormats || []).filter(f => f.type?.startsWith('audio/'));
    if (!formats.length) throw new Error('no audio formats');
    const m4a = formats.filter(f => f.type?.includes('audio/mp4'));
    const pool = m4a.length ? m4a : formats;
    pool.sort((a, b) => parseInt(b.bitrate) - parseInt(a.bitrate));
    return pool[0].url;
  } catch (e) {
    console.warn(`[Invidious] ${base} failed:`, e.message);
    return resolveViaInvidious(videoId, attempt + 1);
  }
}

// Master resolver: InnerTube → Piped → Invidious
async function resolveAudioUrl(videoId) {
  let url = await resolveViaInnertube(videoId);
  if (url) return url;

  console.warn('[resolveAudioUrl] InnerTube failed, trying Piped...');
  url = await resolveViaPiped(videoId);
  if (url) return url;

  console.warn('[resolveAudioUrl] Piped failed, trying Invidious...');
  url = await resolveViaInvidious(videoId);
  return url; // null if all fail
}

async function loadStreamForTrack(track) {
  showLoadingState(true);

  const audioUrl = await resolveAudioUrl(track.videoId);

  if (!audioUrl) {
    showLoadingState(false);
    toast('No audio source found — check your connection');
    return;
  }

  // Only apply if this track is still the current one
  if (state.currentTrack?.videoId !== track.videoId) return;

  AUDIO.src = audioUrl;
  AUDIO.volume = state.volumeLevel / 100;
  AUDIO.load();
  AUDIO.play().catch(e => {
    console.warn('play() blocked:', e);
    showLoadingState(false);
    updatePlayIcons(false);
  });
}

/* ── PLAYBACK CONTROLS ── */
async function playTrack(track, queueOverride, idx) {
  if (queueOverride) { state.queue = queueOverride; state.queueIdx = idx ?? 0; }
  state.currentTrack = track;
  state.playing = false;
  state.loading = true;

  // Immediately update UI
  updateNowPlaying(track);
  updateMiniPlayer(track);
  updateArtColor(track.thumb);
  resetProgressUI();
  setupMediaSession(track);
  showLoadingState(true);
  addToHistory(track);

  // Kick off stream resolution (InnerTube → Piped → Invidious)
  loadStreamForTrack(track);
}

function togglePlayPause() {
  if (!state.currentTrack) return;
  if (state.playing) {
    AUDIO.pause();
  } else {
    if (!AUDIO.src || AUDIO.src === window.location.href) {
      // No src yet — reload stream
      loadStreamForTrack(state.currentTrack);
    } else {
      AUDIO.play().catch(() => {});
    }
  }
}

function seekPrev() {
  if (AUDIO.currentTime > 3) { AUDIO.currentTime = 0; return; }
  if (state.queueIdx > 0) {
    state.queueIdx--;
    playTrack(state.queue[state.queueIdx]);
  } else if (state.repeat === 'all' && state.queue.length) {
    state.queueIdx = state.queue.length - 1;
    playTrack(state.queue[state.queueIdx]);
  }
}

function seekNext() {
  if (state.shuffle && state.queue.length > 1) {
    let next;
    do { next = Math.floor(Math.random() * state.queue.length); } while (next === state.queueIdx);
    state.queueIdx = next;
    playTrack(state.queue[next]);
    return;
  }
  if (state.queueIdx < state.queue.length - 1) {
    state.queueIdx++;
    playTrack(state.queue[state.queueIdx]);
  } else if (state.repeat === 'all' && state.queue.length) {
    state.queueIdx = 0;
    playTrack(state.queue[0]);
  }
}

/* ── LOADING STATE ── */
function showLoadingState(loading) {
  state.loading = loading;
  const ppPlay  = el('pp-play');
  const ppPause = el('pp-pause');
  const ppSpin  = el('pp-spin');
  if (!ppPlay) return;
  if (loading) {
    ppPlay.style.display  = 'none';
    ppPause.style.display = 'none';
    if (ppSpin) ppSpin.style.display = '';
  } else {
    if (ppSpin) ppSpin.style.display = 'none';
    updatePlayIcons(state.playing);
  }
}

/* ── PROGRESS LOOP ── */
let progressRAF = null;
function startProgressLoop() {
  if (progressRAF) cancelAnimationFrame(progressRAF);
  function tick() {
    if (!state.playing) return;
    const cur = AUDIO.currentTime || 0;
    const dur = AUDIO.duration   || 0;
    state.currentDuration = dur;
    const pct = dur ? (cur / dur) * 100 : 0;
    updateProgressUI(pct, cur, dur);
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && dur > 0) {
      try { navigator.mediaSession.setPositionState({ duration: dur, playbackRate: 1, position: cur }); } catch {}
    }
    progressRAF = requestAnimationFrame(tick);
  }
  progressRAF = requestAnimationFrame(tick);
}

function updateProgressUI(pct, cur, dur) {
  const slider = el('np-progress');
  if (!slider) return;
  slider.value = pct;
  slider.style.setProperty('--pct', Math.max(pct, 0.01) + '%');
  el('np-current').textContent  = fmtTime(cur);
  el('np-duration').textContent = fmtTime(dur);
}

function resetProgressUI() { updateProgressUI(0.01, 0, 0); }

/* ── MEDIA SESSION API (lock screen controls) ── */
function setupMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title:   track.title,
    artist:  track.artist,
    album:   'Aspotï',
    artwork: track.thumb ? [
      { src: track.thumb, sizes: '320x180', type: 'image/jpeg' },
      { src: track.thumb, sizes: '640x360', type: 'image/jpeg' },
    ] : [],
  });
  navigator.mediaSession.setActionHandler('play',          () => AUDIO.play().catch(() => {}));
  navigator.mediaSession.setActionHandler('pause',         () => AUDIO.pause());
  navigator.mediaSession.setActionHandler('previoustrack', () => seekPrev());
  navigator.mediaSession.setActionHandler('nexttrack',     () => seekNext());
  navigator.mediaSession.setActionHandler('seekto', e => {
    if (state.currentDuration) AUDIO.currentTime = e.seekTime;
  });
  navigator.mediaSession.setActionHandler('seekbackward', e => {
    AUDIO.currentTime = Math.max(0, AUDIO.currentTime - (e.seekOffset || 10));
  });
  navigator.mediaSession.setActionHandler('seekforward', e => {
    AUDIO.currentTime = Math.min(AUDIO.duration || 0, AUDIO.currentTime + (e.seekOffset || 10));
  });
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
  if (isLiked(track.videoId)) {
    state.liked = state.liked.filter(t => t.videoId !== track.videoId);
    toast('Removed from Liked Songs');
  } else {
    state.liked.unshift(track);
    toast('Added to Liked Songs ♡');
  }
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
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=20&q=${encodeURIComponent(query)}&key=${state.apiKey}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (err.error?.code === 403) toast('API quota hit — try again later');
      return [];
    }
    const data = await res.json();
    return (data.items || []).map(item => ({
      videoId: item.id.videoId,
      title:   decodeHTML(item.snippet.title),
      artist:  decodeHTML(item.snippet.channelTitle),
      thumb:   item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
    }));
  } catch {
    toast('Search failed — check your connection');
    return [];
  }
}

/* ── ART COLOR EXTRACTION ── */
function updateArtColor(thumbUrl) {
  if (!thumbUrl) return;
  const img = new Image();
  // Don't set crossOrigin — it can interrupt the iOS media session assertion
  img.onload = function () {
    try {
      const c = document.createElement('canvas');
      c.width = 40; c.height = 40;
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

/* ── PLAY/PAUSE ICON UPDATE ── */
function updatePlayIcons(playing) {
  const ppPlay  = el('pp-play');
  const ppPause = el('pp-pause');
  if (!ppPlay) return;
  ppPlay.style.display  = playing ? 'none' : '';
  ppPause.style.display = playing ? '' : 'none';

  // Mini player icon
  const miniIcon = el('mini-play-icon');
  if (miniIcon) {
    miniIcon.innerHTML = playing
      ? '<path d="M6 19h4V5H6zm8-14v14h4V5z"/>'
      : '<path d="M8 5v14l11-7z"/>';
  }
}

/* ── PAGE NAVIGATION ── */
function switchPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  el(pageId)?.classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === pageId));
  const titles = { 'page-home':'Listen Now','page-search':'Search','page-library':'Library','page-settings':'Settings' };
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

function closePlaylistDetail() {
  el('playlist-detail').classList.add('hidden');
  state.currentPlaylistId = null;
}

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
  overlay.style.cssText = 'position:fixed;inset:0;z-index:149;background:rgba(0,0,0,.5);';
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
    el('search-results').innerHTML = '<div class="empty-state"><div class="empty-icon spin-icon">⟳</div></div>';
    ensureSpinStyle();
    const results = await searchYouTube(query);
    renderSearchResults(results);
  }, 500);
}

function ensureSpinStyle() {
  if (!document.getElementById('spin-style')) {
    const s = document.createElement('style');
    s.id = 'spin-style';
    s.textContent = '@keyframes spin{to{transform:rotate(360deg)}}.spin-icon{display:inline-block;animation:spin 1s linear infinite}';
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
  if (!s || isNaN(s)) return '0:00';
  return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}
function esc(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function decodeHTML(str) {
  const t = document.createElement('textarea'); t.innerHTML = str; return t.value;
}

/* ── iOS BACKGROUND AUDIO SESSION KEEP-ALIVE ── */
// iOS PWAs suspend the audio session after ~30s of backgrounding.
// On visibilitychange (screen unlock / app resume), if we were playing
// but audio got suspended, re-issue play() to reclaim the media session.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.currentTrack) {
    if (state.playing && AUDIO.paused) {
      AUDIO.play().catch(() => {
        // Session fully dead — reload the stream
        loadStreamForTrack(state.currentTrack);
      });
    }
    // Refresh Media Session so lock-screen controls reappear
    if ('mediaSession' in navigator) setupMediaSession(state.currentTrack);
  }
});

/* ── SWIPE DOWN TO CLOSE NOW PLAYING ── */
(function setupSwipe() {
  const sheet = document.getElementById('now-playing-sheet');
  let startY = 0, curY = 0, dragging = false;
  sheet.addEventListener('touchstart', e => { startY = e.touches[0].clientY; dragging = true; }, { passive: true });
  sheet.addEventListener('touchmove',  e => {
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

/* ══════════════════════════════════════════════════
   EVENT LISTENERS
   ══════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  renderHome();

  // Volume init
  const volSlider = el('np-volume');
  AUDIO.volume = state.volumeLevel / 100;
  volSlider.value = state.volumeLevel;
  volSlider.style.setProperty('--vol-pct', state.volumeLevel + '%');

  // Initial play icon state
  updatePlayIcons(false);

  /* ── Bottom nav ── */
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchPage(btn.dataset.page));
  });

  /* ── Library tabs ── */
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

  /* ── Search ── */
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
  });
  el('btn-search-top').addEventListener('click', () => {
    switchPage('page-search');
    setTimeout(() => el('search-input').focus(), 100);
  });

  /* ── Mini player ── */
  el('mini-player').addEventListener('click', e => { if (!e.target.closest('button')) openNowPlaying(); });
  el('mini-play-btn').addEventListener('click', e => { e.stopPropagation(); togglePlayPause(); });
  el('mini-next-btn').addEventListener('click', e => { e.stopPropagation(); seekNext(); });
  el('mini-like-btn').addEventListener('click', e => { e.stopPropagation(); if (state.currentTrack) toggleLike(state.currentTrack); });

  /* ── Now Playing ── */
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
    el('np-repeat').classList.toggle('active', state.repeat !== 'none');
    toast({ none:'Repeat off', all:'Repeat all', one:'Repeat one' }[state.repeat]);
  });

  el('np-progress').addEventListener('input', e => {
    if (!state.currentDuration) return;
    const pct = parseFloat(e.target.value);
    AUDIO.currentTime = (pct / 100) * state.currentDuration;
    e.target.style.setProperty('--pct', pct + '%');
  });

  el('np-volume').addEventListener('input', e => {
    state.volumeLevel = parseInt(e.target.value);
    AUDIO.volume = state.volumeLevel / 100;
    save.volume();
    e.target.style.setProperty('--vol-pct', state.volumeLevel + '%');
  });

  /* ── Playlists ── */
  el('btn-new-playlist').addEventListener('click', () => el('modal-new-playlist').classList.remove('hidden'));
  el('modal-pl-cancel').addEventListener('click',  () => closeModal('modal-new-playlist'));
  el('modal-pl-create').addEventListener('click',  () => {
    const name = el('playlist-name-input').value.trim();
    if (name) { createPlaylist(name); el('playlist-name-input').value = ''; closeModal('modal-new-playlist'); }
  });
  el('playlist-name-input').addEventListener('keydown', e => { if (e.key === 'Enter') el('modal-pl-create').click(); });
  el('modal-atp-cancel').addEventListener('click', () => closeModal('modal-add-to-playlist'));

  /* ── Playlist detail ── */
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
      state.shuffle = true;
      el('np-shuffle').classList.add('active');
      const idx = Math.floor(Math.random() * pl.tracks.length);
      playTrack(pl.tracks[idx], pl.tracks, idx);
      el('np-queue-name').textContent = pl.name;
      openNowPlaying();
    } else toast('No songs in playlist');
  });

  /* ── Settings ── */
  el('btn-clear-data').addEventListener('click', () => {
    if (confirm('Clear all data? Playlists, liked songs, and history will be removed.')) {
      ['playlists','liked','history','volume'].forEach(k => localStorage.removeItem('aspoti_' + k));
      location.reload();
    }
  });

  el('toggle-bg-audio').checked = true;

  /* ── Modal backdrop close ── */
  document.querySelectorAll('.modal-overlay').forEach(m => {
    m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); });
  });
});

/* ── SERVICE WORKER ── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
