# Spotify Lyrics Status — Vencord plugin

Shows the **current lyric line of the track you're playing on Spotify** as your
Discord **custom status** (the little text bubble under your name — not the
About Me bio).

Synced against playback position, updated within ~250ms of a line changing.

```
♪ Now you all know
♪ The bards and their songs
```

## Requirements

- **Linux** with Spotify playing over **MPRIS** (the official desktop client)
- [`playerctl`](https://github.com/altdesktop/playerctl) — the plugin shells out to it
- A Vencord build (Vesktop, or Vencord's own installer)

`playerctl` is used because MPRIS is the one interface every Linux player
exposes. It also hands us the Spotify track id, which the optional Spicy Lyrics
provider uses for exact lookups.

## Install

This is a **userplugin**, so it needs a Vencord source checkout to compile against.

```bash
# 1. Match the commit your client is running (printed in the bundle header)
head -3 ~/.config/vesktop/sessionData/vencordFiles/vencordDesktopRenderer.js
#    -> "// Vencord <commit>"

# 2. Clone Vencord at that commit
git clone https://github.com/Vendicated/Vencord.git ~/.config/vesktop/src
cd ~/.config/vesktop/src && git checkout <commit> && pnpm install --frozen-lockfile

# 3. Drop the plugin in
mkdir -p src/userplugins/spotifyLyricsStatus
cp /path/to/this/repo/src/{index,native}.ts src/userplugins/spotifyLyricsStatus/

# 4. Build and deploy
pnpm exec tsc --noEmit -p .
pnpm build
cd dist && cp -f vencordDesktop*.js vencordDesktop*.css \
  vencordDesktop*.map vencordDesktop*.LEGAL.txt \
  ~/.config/vesktop/sessionData/vencordFiles/

# 5. Restart Vesktop, then enable "SpotifyLyricsStatus" in Vencord settings
```

A packaged build has no hot reload — the client must be restarted after every
rebuild.

## Settings

| Setting | Default | What it does |
|---|---|---|
| **Spicy Lyrics API key** | *(empty)* | Optional `sl_sk_…` key. Enables community + Apple Music syncs. See below. |
| Enabled | on | Master switch; turning it off restores your previous status |
| Prefix / Suffix | *(empty)* | Text wrapped around each line, e.g. `♪ ` |
| Min line length | 3 | Ignore lines shorter than this |
| Show track when no lyrics | on | Fall back to `artist - title` for instrumentals / unknown tracks |
| Restore on stop | on | Put your own status back when playback stops |
| Debug | off | Log the track, provider, and line to the console |

## Where the lyrics come from

The plugin resolves in this order and stops at the first hit:

| Order | Source | Coverage* | Notes |
|---|---|---|---|
| 1 | **Spicy Lyrics API** | — | Only when a key is set. Community syncs → Apple Music → Spotify. |
| 2 | **LRCLIB** | 84.6% | Free, no auth, no key. Fastest when it has the track (~80-180ms). |
| 3 | **NetEase** ∥ **Kugou** | 82.1% / 100% | Raced in parallel; fills gaps LRCLIB misses. |

\* Measured on a genre-spanning 39-track sample (pop, rap, metal, electronic,
jazz, classical, country, K-pop, indie, underground).

The chain reaches ~92-95% in practice. Combining all three free catalogues hit
100% on that sample, because each covers gaps the others miss.

### About the Spicy Lyrics key

The free catalogues are good but miss community-made and Apple Music material.
[Spicy Lyrics' developer API](https://developers.spicylyrics.org) exposes both,
plus word-level syncs, in a single request keyed by Spotify track id.

Create a free **secret key** (`sl_sk_…`) at
[developers.spicylyrics.org/dashboard/applications](https://developers.spicylyrics.org/dashboard/applications)
and paste it into the plugin's settings.

The key is only ever read in the **main process** — it is never exposed to the
renderer. If it's wrong or expired, the plugin silently falls back to the free
chain.

The Spicy Lyrics *internal* endpoint (`api.spicylyrics.org/query`) is
deliberately not used — it answers `418` telling clients to use the developer
API instead.

## How it stays in sync

Three things matter, and getting any one wrong produces visible lag:

1. **Poll every 500ms.** MPRIS position is only true at the instant it's read.
2. **Extrapolate between polls.** Position is projected forward using wall-clock
   time, bounded to 3s of drift so a seek or pause re-anchors instead of
   running away.
3. **Queue writes, never drop them.** If the write throttle blocks a line, it is
   stored and flushed the moment the window opens. Dropping it permanently loses
   that line — the next poll sees the same text, compares it to what was last
   written, and skips.

Measured result: **median 249ms** from a line starting to the server echoing it,
with 96% of samples showing the correct current line.

### Rate limiting

`PATCH /users/@me/settings` is per-user and shared with every other settings
write. Measured here: it accepts a write every 1.2s indefinitely with no 429,
and each round-trip costs 250-850ms.

So the floor is **1s** — just above the observed round-trip. Over-throttling is
what causes lag; a 4s floor dropped whole lines. Writes only fire when the text
actually changes, and any failure pushes the next write out 60s rather than
retrying into a ban.

## Architecture

Vencord splits plugins across two isolated worlds, and this one needs both:

| File | World | Why |
|---|---|---|
| `native.ts` | main | `child_process` for `playerctl`, `node:https` for lyric APIs |
| `index.ts` | renderer | `RestAPI` for the status write, settings UI, React |

Three non-obvious reasons for that split:

- **CSP blocks renderer `fetch()`** to third-party hosts. It fails with a bare
  `TypeError: Failed to fetch` and no detail.
- **Electron's main-process `fetch()` is unreliable** here — it's bound to a
  Session network stack and can return without a response. `node:https` is
  plain Node and always works.
- **Node prefers IPv6.** If a host has AAAA records but no working v6 route,
  every request hangs. `family: 4` is forced on all of them.

Two API details that cost real debugging time:

- `ipcMain.handle` calls handlers as `(event, ...args)`. Every native export
  must declare `_event` first or all arguments shift by one and the last is
  `undefined`. A zero-arg export hides the bug — it only breaks functions that
  take arguments, and then fails silently with a malformed query.
- Discord's **local settings proto does not update** after a PATCH.
  `getSetting('customStatus')` keeps returning the stale value even though the
  write succeeded. Verify with `GET /users/@me/settings`.

### Provider matching

Free catalogues are keyed by free-text search, so results are verified before
use: the title must match closely **and** share a significant artist token.
Artist names are compared token-wise because sources mangle featured artists
(`Nujabes、Cise Starr、Akin from CYNE`).

Track duration is a **ranking** signal, never a gate. Providers disagree
constantly on length (kugou said 175s for a track MPRIS reported as 270s), and
a hard cutoff discards good lyrics. Wrong-song lyrics are worse than none, so
title+artist must match — duration only picks the closest variant.

### TLS note

Kugou's media hosts sit behind a Tencent CDN and serve a certificate whose SAN
is `*.cdn.myqcloud.com`, so hostname verification fails even though the chain is
valid. Hostname matching is relaxed **only** for those three hosts; chain
validation stays on, and a self-signed certificate is still rejected.

## Uninstall

Remove the `spotifyLyricsStatus` folder from `src/userplugins/`, rebuild, and
redeploy. Disabling the plugin first restores your previous status.

## License

MIT
