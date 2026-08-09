/* ═══════════════════════════════════════════════════
   ASPOTÏ · app.js
   Free music PWA · YouTube-powered · No ads, no limits
   ═══════════════════════════════════════════════════ */

'use strict';

/* ── STORAGE (localStorage wrapper) ── */
const DB = {
  _k: k => 'aspoti_' + k,
  get(k, fallback = null) {
    try { const v = localStorage.getItem(this._k(k)); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem(this._k(k), JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(this._k(k)); } catch {} },
};

/* ── STATE ── */
const state = {
  apiKey: 'AIzaSyBgibbTvE7Khph08tK5BlVOjZ3DGk_nTYk',
  playlists: DB.get('playlists', []),
  liked: DB.get('liked', []),
  history: DB.get('history', []),
  queue: [],
  queueIdx: -1,
  shuffle: false,
  repeat: 'none',       // 'none' | 'all' | 'one'
  playing: false,
  currentTrack: null,
  currentDuration: 0,
  volumeLevel: DB.get('volume', 80),
  bgAudio: DB.get('bgAudio', true),
  currentPlaylistId: null,
  loading: false,
};

/* ── SAVE helpers ── */
const save = {
  playlists() { DB.set('playlists', state.playlists); },
  liked()     { DB.set('liked',     state.liked);     },
  history()   { DB.set('history',   state.history);   },
  volume()    { DB.set('volume',    state.volumeLevel); },
};

/* ════════════════════════════════════════════════════
   NATIVE AUDIO ENGINE
   Uses a real <audio> element so iOS keeps playing in
   the background / with screen off — iframes can't do this.
   Audio URL is resolved via Piped public instances —
   open-source YouTube proxies with no key required.
   Falls back through multiple instances automatically.
   ════════════════════════════════════════════════════ */

const AUDIO = new Audio();
AUDIO.preload = 'auto';

// Public Piped API instances — tried in order until one works.
// These return direct YouTube CDN audio stream URLs.
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://piped-api.garudalinux.org',
  'https://api.piped.yt',
  'https://piped.syncrea.eu',
  'https://piped.drgns.space',
];

async function resolveAudioUrl(videoId) {
  for (const base of PIPED_INSTANCES) {
    try {
      const res = await fetch(`${base}/streams/${videoId}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(9000),
      });
      if (!res.ok) continue;
      const data = await res.json();

      // data.audioStreams is an array of { url, bitrate, mimeType, ... }
      const streams = (data.audioStreams || [])
        .filter(s => s.url && s.mimeType && s.mimeType.includes('audio'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      if (streams.length > 0) {
        return streams[0].url;
      }
    } catch {
      // Instance unreachable or timed out — try next
    }
  }
  return null;
}

/* ── PLAYBACK ── */
async function playTrack(track, queueOverride, idx) {
  if (queueOverride) { state.queue = queueOverride; state.queueIdx = idx ?? 0; }
  state.currentTrack = track;
  state.playing = false;
  state.loading = true;

  updateNowPlaying(track);
  updateMiniPlayer(track);
  updateArtColor(track.thumb);
  resetProgressUI();
  setupMediaSession(track);
  showLoadingState(true);

  // Stop current playback immediately
  AUDIO.pause();
  AUDIO.src = '';

  try {
    const url = await resolveAudioUrl(track.videoId);
    if (!url) {
      toast('Could not load audio — try another song');
      showLoadingState(false);
      state.loading = false;
      return;
    }

    // If the user tapped another song while this was resolving, bail
    if (state.currentTrack?.videoId !== track.videoId) return;

    AUDIO.src = url;
    AUDIO.volume = state.volumeLevel / 100;
    await AUDIO.play();
    addToHistory(track);
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'NotAllowedError') return;
    toast('Playback failed — trying next song');
    showLoadingState(false);
    state.loading = false;
    seekNext();
  }
}

function togglePlayPause() {
  if (!state.currentTrack) return;
  if (state.playing) {
    AUDIO.pause();
  } else {
    AUDIO.play().catch(() => {});
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
  if (state.shuffle) {
    const next = Math.floor(Math.random() * state.queue.length);
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

/* ── AUDIO ELEMENT EVENT HANDLERS ── */
AUDIO.addEventListener('play', () => {
  state.playing = true;
  state.loading = false;
  showLoadingState(false);
  updatePlayIcons(true);
  artContainer.classList.add('playing');
  artContainer.classList.remove('paused');
  startProgressLoop();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
});

AUDIO.addEventListener('pause', () => {
  state.playing = false;
  updatePlayIcons(false);
  artContainer.classList.remove('playing');
  artContainer.classList.add('paused');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
});

AUDIO.addEventListener('ended', () => {
  state.playing = false;
  if (state.repeat === 'one') {
    AUDIO.currentTime = 0;
    AUDIO.play().catch(() => {});
    return;
  }
  seekNext();
});

AUDIO.addEventListener('error', () => {
  if (!state.currentTrack) return;
  state.loading = false;
  showLoadingState(false);
  toast('Stream error — skipping');
  seekNext();
});

AUDIO.addEventListener('waiting', () => showLoadingState(true));
AUDIO.addEventListener('canplay', () => { showLoadingState(false); });

/* ── LOADING STATE ── */
function showLoadingState(loading) {
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
    // Keep Media Session position in sync
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && dur) {
      try {
        navigator.mediaSession.setPositionState({ duration: dur, playbackRate: 1, position: cur });
      } catch {}
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
  el('np-current').textContent = fmtTime(cur);
  el('np-duration').textContent = fmtTime(dur);
}

function resetProgressUI() {
  updateProgressUI(0.01, 0, 0);
}

/* ── MEDIA SESSION API ── */
function setupMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title:   track.title,
    artist:  track.artist,
    album:   'Aspotï',
    artwork: track.thumb
      ? [{ src: track.thumb, sizes: '320x180', type: 'image/jpeg' }]
      : [],
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
    AUDIO.currentTime = Math.min(AUDIO.duration, AUDIO.currentTime + (e.seekOffset || 10));
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
    b.querySelector('svg path') && b.querySelector('svg').classList.toggle('filled', liked);
  });
  const npHeart = el('np-heart');
  if (state.currentTrack?.videoId === videoId) {
    npHeart.classList.toggle('filled', liked);
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
      const err = await res.json();
      if (err.error?.code === 403) toast('API key invalid or quota exceeded');
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
  img.crossOrigin = 'anonymous';
  img.onload = function () {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 40; canvas.height = 40;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 40, 40);
      const d = ctx.getImageData(0, 0, 40, 40).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 16) {
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
      }
      r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
      const color = `rgb(${r},${g},${b})`;
      el('sheet-bg-blur').style.setProperty('--art-color', color);
      el('np-glow').style.setProperty('--art-color', color);
    } catch {}
  };
  img.src = thumbUrl;
}

/* ── UI UPDATE HELPERS ── */
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
  el('mini-title').textContent    = track.title;
  el('mini-artist').textContent   = track.artist;
  el('mini-art-img').src          = track.thumb;
  el('mini-like-btn').classList.toggle('liked', isLiked(track.videoId));
  el('mini-player').classList.remove('hidden');
}

function updatePlayIcons(playing) {
  const ppPlay  = el('pp-play');
  const ppPause = el('pp-pause');
  if (ppPlay && ppPause) {
    ppPlay.style.display  = playing ? 'none' : '';
    ppPause.style.display = playing ? ''     : 'none';
  }
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
  el(pageId).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.page === pageId);
  });
  const titles = {
    'page-home':     'Listen Now',
    'page-search':   'Search',
    'page-library':  'Library',
    'page-settings': 'Settings',
  };
  el('page-title').textContent = titles[pageId] || '';
  if (pageId === 'page-library') renderLibrary();
  if (pageId === 'page-home')    renderHome();
}

/* ── NOW PLAYING SHEET ── */
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
  if (thumbs.length <= 1) {
    grid.classList.add('single');
    if (thumbs[0]) { const img = new Image(); img.src = thumbs[0]; grid.appendChild(img); }
  } else {
    grid.classList.remove('single');
    thumbs.forEach(src => { const img = new Image(); img.src = src; grid.appendChild(img); });
  }

  const list = el('pl-track-list');
  list.innerHTML = '';
  if (pl.tracks.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">🎵</div><p>Empty playlist</p><span>Search for songs and add them here</span></div>';
  } else {
    pl.tracks.forEach((track, i) => {
      list.appendChild(buildTrackItem(track, {
        queue: pl.tracks, idx: i, context: pl.name,
        onRemove: () => removeFromPlaylist(id, track.videoId),
      }));
    });
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
      <img src="${track.thumb}" alt="" loading="lazy" />
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
    </div>
  `;

  div.querySelector('.track-thumb').addEventListener('click', () => {
    const queue = opts.queue || [track];
    const idx   = opts.idx ?? 0;
    state.queue    = queue;
    state.queueIdx = idx;
    if (opts.context) el('np-queue-name').textContent = opts.context;
    playTrack(track);
    openNowPlaying();
  });

  div.querySelector('.track-like-btn').addEventListener('click', e => {
    e.stopPropagation();
    toggleLike(track);
  });

  div.querySelector('.track-more-btn').addEventListener('click', e => {
    e.stopPropagation();
    showTrackMenu(track, opts.onRemove);
  });

  return div;
}

/* ── TRACK CONTEXT MENU ── */
function showTrackMenu(track, onRemove) {
  const existing = document.getElementById('track-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.id = 'track-menu';
  menu.style.cssText = `
    position:fixed;bottom:0;left:0;right:0;z-index:150;
    background:var(--card);border-radius:var(--sheet-radius) var(--sheet-radius) 0 0;
    padding:8px 0 calc(var(--safe-bot) + 16px);
    animation:slideUp .3s cubic-bezier(.32,0,.04,1);
  `;

  const items = [
    { icon: '♡', label: isLiked(track.videoId) ? 'Remove from Liked' : 'Add to Liked', action: () => toggleLike(track) },
    { icon: '＋', label: 'Add to Playlist', action: () => openAddToPlaylist(track) },
  ];
  if (onRemove) items.push({ icon: '✕', label: 'Remove from Playlist', action: onRemove, danger: true });

  items.forEach(item => {
    const btn = document.createElement('button');
    btn.style.cssText = `
      width:100%;display:flex;align-items:center;gap:16px;padding:16px 24px;
      font-size:17px;font-weight:500;color:${item.danger ? '#ff453a' : 'var(--text)'};
      background:none;border:none;text-align:left;
    `;
    btn.innerHTML = `<span style="font-size:20px;width:28px;text-align:center">${item.icon}</span><span>${item.label}</span>`;
    btn.addEventListener('click', () => { item.action(); menu.remove(); overlay.remove(); });
    menu.appendChild(btn);
  });

  const cancel = document.createElement('button');
  cancel.style.cssText = `
    width:calc(100% - 32px);margin:8px 16px 0;padding:16px;
    background:var(--card2);border-radius:var(--radius);
    font-size:17px;font-weight:600;color:var(--text);border:none;
  `;
  cancel.textContent = 'Cancel';
  menu.appendChild(cancel);

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:149;background:rgba(0,0,0,.5);';
  overlay.addEventListener('click', () => { menu.remove(); overlay.remove(); });
  cancel.addEventListener('click', () => { menu.remove(); overlay.remove(); });

  document.body.appendChild(overlay);
  document.body.appendChild(menu);

  if (!document.getElementById('slide-up-style')) {
    const s = document.createElement('style');
    s.id = 'slide-up-style';
    s.textContent = '@keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}';
    document.head.appendChild(s);
  }
}

/* ── ADD TO PLAYLIST MODAL ── */
function openAddToPlaylist(track) {
  const modal  = el('modal-add-to-playlist');
  const picker = el('playlist-picker');
  picker.innerHTML = '';

  if (state.playlists.length === 0) {
    picker.innerHTML = '<div style="padding:12px;color:var(--text2);font-size:14px;text-align:center">No playlists yet. Create one in the Library tab.</div>';
  } else {
    state.playlists.forEach(pl => {
      const div = document.createElement('div');
      div.className = 'playlist-pick-item';
      const thumb = pl.tracks[0]?.thumb || '';
      div.innerHTML = `<img src="${thumb}" alt="" /><span>${esc(pl.name)}</span>`;
      div.addEventListener('click', () => {
        addToPlaylist(pl.id, track);
        closeModal('modal-add-to-playlist');
      });
      picker.appendChild(div);
    });
  }
  modal.classList.remove('hidden');
}

function closeModal(id) { el(id).classList.add('hidden'); }

/* ── RENDER FUNCTIONS ── */
function renderHome() {
  renderHomeRecent();
  renderHomePlaylists();
  renderHomeLiked();
  setGreeting();
}

function setGreeting() {
  const h = new Date().getHours();
  const g = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  el('greeting-text').textContent = g;
}

function renderHomeRecent() {
  const grid = el('recent-grid');
  grid.innerHTML = '';
  if (state.history.length === 0) {
    grid.innerHTML = '<div class="empty-state-small">Start searching to build your history</div>';
    return;
  }
  state.history.slice(0, 6).forEach(track => {
    const div = document.createElement('div');
    div.className = 'recent-item';
    div.innerHTML = `<img src="${track.thumb}" alt="" /><span>${esc(track.title)}</span>`;
    div.addEventListener('click', () => { playTrack(track, [track], 0); openNowPlaying(); });
    grid.appendChild(div);
  });
}

function renderHomePlaylists() {
  const row = el('home-playlists');
  row.innerHTML = '';
  if (state.playlists.length === 0) {
    row.innerHTML = '<div class="empty-state-small">No playlists yet</div>';
    return;
  }
  state.playlists.forEach(pl => {
    const div = document.createElement('div');
    div.className = 'home-pl-card';
    const thumbs   = pl.tracks.slice(0, 4).map(t => t.thumb).filter(Boolean);
    const isSingle = thumbs.length <= 1;
    div.innerHTML = `
      <div class="home-pl-art ${isSingle ? 'single' : ''}">
        ${thumbs.map(s => `<img src="${s}" alt="" />`).join('')}
      </div>
      <div class="home-pl-name">${esc(pl.name)}</div>
      <div class="home-pl-count">${pl.tracks.length} song${pl.tracks.length !== 1 ? 's' : ''}</div>
    `;
    div.addEventListener('click', () => openPlaylistDetail(pl.id));
    row.appendChild(div);
  });
}

function renderHomeLiked() {
  const row = el('home-liked');
  row.innerHTML = '';
  if (state.liked.length === 0) {
    row.innerHTML = '<div class="empty-state-small">Like songs to see them here</div>';
    return;
  }
  state.liked.slice(0, 8).forEach((track, i) => {
    const div = document.createElement('div');
    div.className = 'recent-item';
    div.innerHTML = `<img src="${track.thumb}" alt="" /><span>${esc(track.title)}</span>`;
    div.addEventListener('click', () => { playTrack(track, state.liked, i); openNowPlaying(); });
    row.appendChild(div);
  });
}

function renderLibrary() {
  renderLibraryPlaylists();
  renderLibraryLiked();
  renderLibraryHistory();
}

function renderLibraryPlaylists() {
  const list  = el('playlist-list');
  const empty = el('empty-playlists');
  list.innerHTML = '';
  if (state.playlists.length === 0) { empty.style.display = ''; return; }
  empty.style.display = 'none';
  state.playlists.forEach(pl => {
    const div   = document.createElement('div');
    div.className = 'track-item';
    const thumb = pl.tracks[0]?.thumb || '';
    div.innerHTML = `
      <div class="track-thumb"><img src="${thumb}" alt="" /></div>
      <div class="track-info">
        <div class="track-title">${esc(pl.name)}</div>
        <div class="track-artist">${pl.tracks.length} songs</div>
      </div>
    `;
    div.addEventListener('click', () => openPlaylistDetail(pl.id));
    list.appendChild(div);
  });
}

function renderLibraryLiked() {
  const list  = el('liked-list');
  const empty = el('empty-liked');
  list.innerHTML = '';
  if (state.liked.length === 0) { empty.style.display = ''; return; }
  empty.style.display = 'none';
  state.liked.forEach((track, i) => {
    list.appendChild(buildTrackItem(track, { queue: state.liked, idx: i, context: 'Liked Songs' }));
  });
}

function renderLibraryHistory() {
  const list  = el('history-list');
  const empty = el('empty-history');
  list.innerHTML = '';
  if (state.history.length === 0) { empty.style.display = ''; return; }
  empty.style.display = 'none';
  state.history.forEach((track, i) => {
    list.appendChild(buildTrackItem(track, { queue: state.history, idx: i, context: 'History' }));
  });
}

function renderSearchResults(tracks) {
  const list  = el('search-results');
  const empty = el('search-empty');
  list.innerHTML = '';
  if (!tracks || tracks.length === 0) { empty.style.display = ''; return; }
  empty.style.display = 'none';
  tracks.forEach((track, i) => {
    list.appendChild(buildTrackItem(track, { queue: tracks, idx: i, context: 'Search' }));
  });
}

/* ── SEARCH ── */
let searchDebounce = null;
function handleSearch(query) {
  if (searchDebounce) clearTimeout(searchDebounce);
  el('search-clear').style.display = query ? 'flex' : 'none';
  if (!query.trim()) {
    el('search-results').innerHTML = '';
    el('search-empty').style.display = '';
    return;
  }
  searchDebounce = setTimeout(async () => {
    el('search-empty').style.display = 'none';
    el('search-results').innerHTML = '<div class="empty-state"><div class="empty-icon" style="animation:spin 1s linear infinite">⟳</div></div>';
    if (!document.getElementById('spin-style')) {
      const s = document.createElement('style');
      s.id = 'spin-style';
      s.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
      document.head.appendChild(s);
    }
    const results = await searchYouTube(query);
    renderSearchResults(results);
  }, 500);
}

/* ── TOAST ── */
function toast(msg, duration = 2200) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  t.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.classList.add('hidden'), 300);
  }, duration);
}

/* ── UTILS ── */
function fmtTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const m   = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
}

function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function decodeHTML(str) {
  const txt = document.createElement('textarea');
  txt.innerHTML = str;
  return txt.value;
}

/* ── SWIPE TO DISMISS SHEET ── */
(function setupSwipe() {
  const sheet = document.getElementById('now-playing-sheet');
  let startY = 0, curY = 0, dragging = false;

  sheet.addEventListener('touchstart', e => {
    startY = e.touches[0].clientY;
    dragging = true;
  }, { passive: true });

  sheet.addEventListener('touchmove', e => {
    if (!dragging) return;
    curY = e.touches[0].clientY;
    const dy = curY - startY;
    if (dy > 0) {
      sheet.style.transform = `translateY(${dy}px)`;
      sheet.style.transition = 'none';
    }
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

/* ── EVENT LISTENERS ── */
document.addEventListener('DOMContentLoaded', () => {

  renderHome();
  setGreeting();

  // Volume init
  el('np-volume').value = state.volumeLevel;
  el('np-volume').style.setProperty('--vol-pct', state.volumeLevel + '%');

  // Nav
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchPage(btn.dataset.page));
  });

  // Library tabs
  document.querySelectorAll('.lib-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.lib-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const which = tab.dataset.tab;
      el('lib-playlists').style.display = which === 'playlists' ? '' : 'none';
      el('lib-liked').style.display     = which === 'liked'     ? '' : 'none';
      el('lib-history').style.display   = which === 'history'   ? '' : 'none';
      if (which === 'liked')   renderLibraryLiked();
      if (which === 'history') renderLibraryHistory();
    });
  });

  // Search
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

  // Mini player
  el('mini-player').addEventListener('click', e => {
    if (e.target.closest('button')) return;
    openNowPlaying();
  });
  el('mini-play-btn').addEventListener('click', e => { e.stopPropagation(); togglePlayPause(); });
  el('mini-next-btn').addEventListener('click', e => { e.stopPropagation(); seekNext(); });
  el('mini-like-btn').addEventListener('click', e => {
    e.stopPropagation();
    if (state.currentTrack) toggleLike(state.currentTrack);
  });

  // Now playing controls
  el('np-close').addEventListener('click', closeNowPlaying);
  el('np-play').addEventListener('click',  togglePlayPause);
  el('np-prev').addEventListener('click',  seekPrev);
  el('np-next').addEventListener('click',  seekNext);
  el('np-like-btn').addEventListener('click',         () => { if (state.currentTrack) toggleLike(state.currentTrack); });
  el('np-add-to-playlist').addEventListener('click',  () => { if (state.currentTrack) openAddToPlaylist(state.currentTrack); });

  el('np-shuffle').addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    el('np-shuffle').classList.toggle('active', state.shuffle);
    toast(state.shuffle ? 'Shuffle on' : 'Shuffle off');
  });

  el('np-repeat').addEventListener('click', () => {
    const modes = ['none', 'all', 'one'];
    state.repeat = modes[(modes.indexOf(state.repeat) + 1) % 3];
    el('np-repeat').classList.toggle('active', state.repeat !== 'none');
    toast({ none: 'Repeat off', all: 'Repeat all', one: 'Repeat one' }[state.repeat]);
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

  el('np-more').addEventListener('click', () => {
    if (state.currentTrack) showTrackMenu(state.currentTrack);
  });

  el('np-airplay').addEventListener('click', () => toast('AirPlay not supported in browser'));

  // Playlists
  el('btn-new-playlist').addEventListener('click', () => el('modal-new-playlist').classList.remove('hidden'));
  el('modal-pl-cancel').addEventListener('click',  () => closeModal('modal-new-playlist'));
  el('modal-pl-create').addEventListener('click',  () => {
    const name = el('playlist-name-input').value.trim();
    if (name) { createPlaylist(name); el('playlist-name-input').value = ''; closeModal('modal-new-playlist'); }
  });
  el('playlist-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') el('modal-pl-create').click();
  });
  el('modal-atp-cancel').addEventListener('click', () => closeModal('modal-add-to-playlist'));

  // Playlist detail
  el('pl-back').addEventListener('click', closePlaylistDetail);
  el('pl-delete').addEventListener('click', () => {
    if (state.currentPlaylistId && confirm('Delete this playlist?')) deletePlaylist(state.currentPlaylistId);
  });
  el('pl-play-all').addEventListener('click', () => {
    const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
    if (pl && pl.tracks.length) {
      playTrack(pl.tracks[0], pl.tracks, 0);
      el('np-queue-name').textContent = pl.name;
      openNowPlaying();
    } else toast('No songs in playlist');
  });
  el('pl-shuffle-all').addEventListener('click', () => {
    const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
    if (pl && pl.tracks.length) {
      state.shuffle = true;
      el('np-shuffle').classList.add('active');
      const idx = Math.floor(Math.random() * pl.tracks.length);
      playTrack(pl.tracks[idx], pl.tracks, idx);
      el('np-queue-name').textContent = pl.name;
      openNowPlaying();
    } else toast('No songs in playlist');
  });

  // Settings
  el('toggle-bg-audio').checked = state.bgAudio;
  el('toggle-bg-audio').addEventListener('change', e => {
    state.bgAudio = e.target.checked;
    DB.set('bgAudio', state.bgAudio);
  });

  el('btn-clear-data').addEventListener('click', () => {
    if (confirm('Clear all data? This will remove your playlists, liked songs, and history.')) {
      ['aspoti_playlists','aspoti_liked','aspoti_history','aspoti_volume'].forEach(k => localStorage.removeItem(k));
      location.reload();
    }
  });

  // Modal overlays close on backdrop click
  document.querySelectorAll('.modal-overlay').forEach(m => {
    m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); });
  });

});

/* ── SERVICE WORKER ── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
