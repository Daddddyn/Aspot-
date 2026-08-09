# Aspotï 🎵

**Free music, no limits.** A PWA music player powered by YouTube — no premium required, no ads, skip anything.

---

## 🚀 Setup in 3 Steps

### 1. Get a Free YouTube API Key (required for search)

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (or use existing)
3. Go to **APIs & Services → Enable APIs**
4. Search for **"YouTube Data API v3"** and enable it
5. Go to **APIs & Services → Credentials → Create Credentials → API Key**
6. Copy the key (it starts with `AIzaSy…`)

> **Free quota:** 10,000 units/day — roughly **100+ searches** per day, totally free.

### 2. Deploy (pick any option)

**Option A: GitHub Pages (recommended, free)**
```
1. Create a new GitHub repo (public or private)
2. Upload all files from this folder
3. Settings → Pages → Deploy from branch → main / root
4. Your app is live at: https://yourusername.github.io/aspoti
```

**Option B: Netlify (drag & drop)**
```
1. Go to netlify.com → drag the aspoti folder onto the deploy area
2. Done — instant live URL
```

**Option C: Local (for testing)**
```bash
# Any of these work:
npx serve .          # Node
python3 -m http.server 8080
php -S localhost:8080
```
> ⚠️ Must be served over HTTP/HTTPS — can't just open index.html directly (CORS)

### 3. Add API Key In-App

1. Open the app → tap **Settings** (gear icon)
2. Paste your YouTube API key
3. Tap **Save** → start searching!

---

## 📱 Install as iPhone App

1. Open the deployed URL in **Safari** on iPhone
2. Tap the **Share** button (box with arrow)
3. Tap **"Add to Home Screen"**
4. Tap **"Add"**

It'll appear like a real app — full screen, no browser UI!

---

## ✨ Features

- 🔍 **Search** any song, artist, or album via YouTube
- ▶️ **Play, pause, skip** — unlimited, always free
- 🔀 **Shuffle & Repeat** (none / all / one)
- ♡ **Like songs** — saved locally to your device
- 📋 **Create playlists** — unlimited, stored locally
- 🕐 **History** — last 50 played tracks
- 🎨 **Dynamic album art colors** — the now-playing screen adapts to the art
- 📱 **iPhone-first design** — no zoom bugs, safe area support, swipe-to-dismiss
- 💾 **100% local storage** — your data never leaves your device
- 🔌 **Works offline** (previously loaded UI) via Service Worker

---

## 🔧 How It Works

- **Audio:** YouTube IFrame Player API — plays YouTube videos in a hidden player. The audio streams just like YouTube does, legally via the official API.
- **Search:** YouTube Data API v3 — same API YouTube's own apps use.
- **Storage:** `localStorage` — all playlists, likes, and history stored directly in your browser.
- **No backend:** Pure client-side PWA. Nothing is sent to any server except YouTube's API.

---

## 📁 File Structure

```
aspoti/
├── index.html      — App shell & all UI
├── style.css       — Apple Music-inspired dark theme
├── app.js          — All logic (player, search, storage, UI)
├── sw.js           — Service Worker (PWA offline)
├── manifest.json   — PWA manifest (name, icons, colors)
└── icons/
    ├── icon-192.png
    └── icon-512.png
```

---

## 🎨 Customization

All design tokens are CSS variables at the top of `style.css`:
```css
--accent:  #FC3C8F;   /* main pink — change this to any color */
--bg:      #0D0D0F;   /* background */
--card:    #1A1A1E;   /* card background */
```

---

Part of the **free-always** app suite. Because there's always a better way.
