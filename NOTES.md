# Maintenance notes — things that cost real debugging time

Written down so the next person (or future me) doesn't rediscover them.

## The three sync bugs

**1. Dropping writes instead of queueing.** The original throttle was:

```ts
if (Date.now() - lastWriteAt < MIN_WRITE_GAP_MS) return;   // WRONG
```

If a line became current 200ms *after* a write, the next poll saw the same
line, compared it to `lastWritten`, and skipped — permanently. That line never
reached Discord. Symptom: some lines stick for ages while others flash past.

Fix: store the text in `pendingText` and flush it on a timer when the window
opens. Never discard a value you meant to publish.

**2. Over-throttling.** A 4s floor "to be safe" was the single biggest cause of
lag. Measured, the endpoint accepts a write every 1.2s indefinitely. The floor
is now 1s — just above the observed 250-850ms round-trip.

**3. No position extrapolation.** MPRIS position is accurate only at read time.
With a 500ms poll, a line boundary could be missed by a full interval. Position
is now projected forward from wall-clock, bounded by `DRIFT_TOLERANCE_MS` so a
seek or pause re-anchors.

## IPC: the event argument

`ipcMain.handle(channel, handler)` invokes `handler(event, ...args)`.

```ts
// WRONG — receives (event, artist, title), duration is undefined
export async function fetchLyrics(artist, title, durationSec) { ... }

// RIGHT
export async function fetchLyrics(_event, artist, title, durationSec) { ... }
```

A **zero-arg** export appears to work, which makes this look intermittent. It
only breaks functions that take arguments, and it fails *silently* with a
malformed query rather than throwing.

## Verifying a status write

`Vencord.Webpack.findByProps('getSetting','updateSetting').getSetting('customStatus')`
returns a **stale local proto**. It does not refresh after a PATCH, so it keeps
showing the old value after a successful write.

```js
await RestAPI.get({ url: '/users/@me/settings' })   // truth
```

Reading the local store is a false negative that sends you debugging working
code. This one burned a lot of time.

## Networking in the main process

- **CSP** blocks renderer `fetch()` to third-party hosts — bare
  `TypeError: Failed to fetch`, no detail.
- **Electron's `fetch()` in main** is bound to a Session network stack and can
  return with no response. Use `node:https`.
- **IPv6**: this box has AAAA records but no v6 route. `https.request` hangs
  while `curl -4` succeeds. Diagnose with `curl -6` vs `curl -4`, then pass
  `family: 4`.
- Use `import { request as httpsRequest }` — a namespace import gets wrapped by
  the bundler into an esModule shim that loses `this` binding.

## Provider matching rules

- Title must match closely **and** share a significant artist token. Loosening
  this produced lyrics for a *different artist's* song with the same title.
- Duration is a **ranking** signal, not a gate. Kugou reported 175s for a track
  MPRIS gave as 270s; a hard filter threw away correct lyrics.
- Never accept a result where the provider has `hasKrc: false` / no lyric body —
  some catalogues return a matching search hit with no lyrics behind it.

## Chain latency

Running fallbacks **serially** stacks their timeouts (measured 3.9s on a full
miss). Racing them with `Promise.all` makes total latency the slowest single
provider, not the sum — 3.9s → 2.2s.

LRCLIB's `/search` endpoint is disproportionately slow on a miss (large
payload). It gets its own 1.8s budget so it can't consume the whole chain.

## Rebuild cycle

There is no hot reload for a packaged build.

```bash
pnpm exec tsc --noEmit -p .   # filter output for the plugin name
pnpm build
cp -f dist/vencordDesktop* ~/.config/vesktop/sessionData/vencordFiles/
# restart the client
```

Deploying and restarting in the same shell call **races** — check the file mtime
against the systemd unit's `ActiveEnterTimestamp` before concluding new code is
loaded.

`pkill -f <pattern>` matches your own command line and kills the tool shell.
Resolve PIDs by exact `comm` and signal by number.

## Debugging a live client

Launch with `--remote-debugging-port=9222`, then query the renderer over CDP.
See `references/cdp-verification.md` in the `electron-client-modding` skill for a
stdlib WebSocket client.

Useful checks:

```js
Object.keys(window.VencordNative.pluginHelpers.SpotifyLyricsStatus)  // every export present
Vencord.Plugins.plugins.SpotifyLyricsStatus.started                  // must be true
await window.VencordNative.pluginHelpers.SpotifyLyricsStatus.getTrack()  // read the RESULT
```

That last one catches real bugs: a plugin can be `enabled: true`,
`started: true`, and still do nothing because its native call fails.
