/*
 * Vencord, a Discord client mod
 * SpotifyLyricsStatus - show the current lyric line of a Spotify track as your custom status.
 */

import { definePluginSettings } from "@api/Settings";
import { RestAPI } from "@webpack/common";
import definePlugin, { OptionType } from "@utils/types";

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

interface Track {
    artist: string;
    title: string;
    /** Spotify track id (used by the Spicy Lyrics provider) */
    id?: string;
    /** playback position in ms */
    position: number;
    /** track length in ms */
    length: number;
    playing: boolean;
}

interface LyricLine {
    /** ms from track start */
    time: number;
    text: string;
}

interface CachedLyrics {
    lines: LyricLine[] | null;
    instrumental: boolean;
    fetchedAt: number;
    /** false when every lookup path errored - short TTL so we retry soon. */
    ok: boolean;
    /** which provider supplied these lines */
    source?: string;
}

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */


/** Discord custom status max length. */
const MAX_STATUS = 128;

/**
 * Measured on this account: /users/@me/settings accepts a PATCH every 1.2s
 * indefinitely with no 429, and each round-trip costs 250-850ms. So the floor
 * is set just above the observed round-trip, not at some "safe" multi-second
 * value -- over-throttling is what caused the visible lag.
 * A 429 still pushes the next write out 60s (see writeStatus).
 */
const MIN_WRITE_GAP_MS = 1_000;

/**
 * Between polls we extrapolate the playback position from wall-clock time so
 * the displayed line flips at the right moment instead of up to POLL_MS late.
 */
const DRIFT_TOLERANCE_MS = 3_000;

/** Don't bother showing very short lines - they flash by and waste writes. */
const DEFAULT_MIN_LINE_LEN = 3;

/**
 * How often we sample MPRIS. 500ms measured as one cheap execFile; 5ms wall.
 * Anything slower than this makes the status lag a whole line behind, because
 * a lyric line often lasts only 2-3s and the poll granularity stacks on top of
 * the write latency.
 */
const POLL_MS = 500;

/** Lyrics cache TTL - same track polled repeatedly shouldn't re-hit the API. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Retry a failed lookup quickly instead of caching the failure for hours. */
const FAILED_TTL_MS = 60_000;

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

const settings = definePluginSettings({
    spicyLyricsKey: {
        type: OptionType.STRING,
        description:
            "Optional: Spicy Lyrics API key (sl_sk_…). Free at developers.spicylyrics.org. "
            + "Adds community and Apple Music syncs ahead of the free catalogues.",
        default: "",
        placeholder: "sl_sk_...",
    },
    enabled: {
        type: OptionType.BOOLEAN,
        description: "Master switch. Turning this off restores your previous status.",
        default: true,
    },
    prefix: {
        type: OptionType.STRING,
        description: "Text placed before the lyric line. Leave blank for none.",
        default: "",
        placeholder: "♪ ",
    },
    suffix: {
        type: OptionType.STRING,
        description: "Text placed after the lyric line.",
        default: "",
    },
    minLineLength: {
        type: OptionType.NUMBER,
        description: "Ignore lyric lines shorter than this many characters.",
        default: DEFAULT_MIN_LINE_LEN,
    },
    showTrackWhenNoLyrics: {
        type: OptionType.BOOLEAN,
        description: "If a track has no synced lyrics, show 'artist - title' instead of nothing.",
        default: true,
    },
    restoreOnStop: {
        type: OptionType.BOOLEAN,
        description: "Restore your previous custom status when playback stops.",
        default: true,
    },
    debug: {
        type: OptionType.BOOLEAN,
        description: "Log the current track and matched line to the console.",
        default: false,
    },
    /*
     * Notes for anyone reading this later:
     *  - Discord's CSP blocks renderer fetch() to lrclib.net, and Electron's
     *    main-process fetch() silently fails here too, so the HTTP call lives
     *    in native.ts over node:https with family:4 forced.
     *  - Node prefers IPv6 but this host has no working IPv6 route, so without
     *    family:4 every request hangs and returns null.
     *  - ipcMain.handle passes (event, ...args); every native export must
     *    discard that first parameter or all arguments shift by one.
     */
});

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

let pollTimer: ReturnType<typeof setInterval> | undefined;
let lyricsCache = new Map<string, CachedLyrics>();

/** The status we last wrote, so we never rewrite an identical string. */
let lastWritten: string | null = null;
/** Timestamp of our last successful write, for the hard rate floor. */
let lastWriteAt = 0;
/** The user's own status captured before we took over. */
let savedStatus: { text: string; emoji_name?: string; emoji_id?: string; expires_at?: string | null } | null = null;
/** True once we've captured the user's status and started driving it. */
let engaged = false;

/* ------------------------------------------------------------------ *
 * MPRIS / playerctl
 * ------------------------------------------------------------------ */

async function readTrack(): Promise<Track | null> {
    // Vencord bridges main-process plugin handlers through
    // VencordNative.pluginHelpers.<pluginName>.<method>.
    const helper = (globalThis as any).VencordNative?.pluginHelpers?.SpotifyLyricsStatus;
    if (!helper?.getTrack) return null;

    try {
        const raw = await helper.getTrack();
        if (!raw) return null;
        return raw as Track;
    } catch {
        return null;
    }
}

/* ------------------------------------------------------------------ *
 * Lyrics
 * ------------------------------------------------------------------ */

function cacheKey(t: Track, duration: number) {
    return `${t.artist}::${t.title}::${Math.round(duration)}`;
}

/**
 * Lyrics are fetched in the MAIN process: Discord's CSP blocks renderer
 * fetch() to lrclib.net outright ("TypeError: Failed to fetch"). The native
 * helper returns already-parsed lines.
 */
async function lrclibFetch(t: Track): Promise<CachedLyrics> {
    const helper = (globalThis as any).VencordNative?.pluginHelpers?.SpotifyLyricsStatus;
    if (!helper?.fetchLyrics) {
        return { lines: null, instrumental: false, fetchedAt: Date.now(), ok: false };
    }

    try {
        const res = await helper.fetchLyrics(
            t.artist,
            t.title,
            t.length / 1000,
            t.id,
            settings.store.spicyLyricsKey?.trim() || undefined
        );
        if (!res) return { lines: null, instrumental: false, fetchedAt: Date.now(), ok: false };
        return {
            lines: res.lines ?? null,
            instrumental: !!res.instrumental,
            fetchedAt: Date.now(),
            ok: res.ok !== false,
            source: res.source,
        };
    } catch {
        return { lines: null, instrumental: false, fetchedAt: Date.now(), ok: false };
    }
}

async function getLyrics(t: Track): Promise<CachedLyrics> {
    const key = cacheKey(t, t.length / 1000);
    const cached = lyricsCache.get(key);
    const ttl = cached && !cached.ok ? FAILED_TTL_MS : CACHE_TTL_MS;
    if (cached && Date.now() - cached.fetchedAt < ttl) return cached;

    const fresh = await lrclibFetch(t);
    lyricsCache.set(key, fresh);

    // bound the cache
    if (lyricsCache.size > 200) {
        const oldest = [...lyricsCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0];
        if (oldest) lyricsCache.delete(oldest[0]);
    }
    return fresh;
}

function lineAt(lines: LyricLine[], positionMs: number): LyricLine | null {
    let current: LyricLine | null = null;
    for (const l of lines) {
        if (l.time <= positionMs) current = l;
        else break;
    }
    return current;
}

/* ------------------------------------------------------------------ *
 * Status write
 * ------------------------------------------------------------------ */

function truncate(s: string) {
    return s.length > MAX_STATUS ? s.slice(0, MAX_STATUS - 1) + "…" : s;
}

/** The value we want on the profile, even if we cannot write it yet. */
let pendingText: string | null = null;
/** Timer that flushes pendingText once the floor allows it. */
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Writes `text`, or schedules it for the earliest moment the floor allows.
 *
 * Returning early on the floor (the previous behaviour) DROPPED the line: if a
 * line became current 200ms after a write, the next poll 500ms later saw the
 * same line, found it equal to what we last wrote, and moved on without ever
 * publishing it. The status then showed the previous line until the next line
 * change. Queueing instead of dropping closes that gap.
 */
function writeStatus(text: string) {
    if (text === lastWritten) return;

    const wait = MIN_WRITE_GAP_MS - (Date.now() - lastWriteAt);
    if (wait > 0) {
        pendingText = text;
        if (!flushTimer) {
            flushTimer = setTimeout(() => {
                flushTimer = undefined;
                const t = pendingText;
                pendingText = null;
                if (t && t !== lastWritten) void doWrite(t);
            }, wait);
        }
        return;
    }

    void doWrite(text);
}

async function doWrite(text: string) {
    try {
        if (settings.store.debug) console.log(`[SpotifyLyricsStatus] writing -> "${text}"`);
        await RestAPI.patch({
            url: "/users/@me/settings",
            body: { custom_status: { text: truncate(text) } },
        });
        lastWritten = text;
        lastWriteAt = Date.now();
    } catch (e) {
        // Back off hard on failure so a 429 doesn't become a tight retry loop.
        lastWriteAt = Date.now() + 60_000;
        if (settings.store.debug) console.warn("[SpotifyLyricsStatus] status write FAILED", e);
    }
}

async function captureOwnStatus() {
    if (engaged) return;
    try {
        const me = await RestAPI.get({ url: "/users/@me/settings" });
        const cs = me?.body?.custom_status;
        savedStatus = cs ? { ...cs } : null;
        engaged = true;
    } catch {
        engaged = true;
    }
}

async function restoreStatus() {
    if (!settings.store.restoreOnStop || !engaged) return;
    try {
        await RestAPI.patch({
            url: "/users/@me/settings",
            body: { custom_status: savedStatus ?? null },
        });
    } catch { /* best effort */ }
    lastWritten = null;
    engaged = false;
    savedStatus = null;
}

/* ------------------------------------------------------------------ *
 * Main loop
 * ------------------------------------------------------------------ */

let currentTrackKey = "";

/** Last MPRIS sample we trust, used to extrapolate between polls. */
let lastSample: { artist: string; title: string; position: number; at: number } | null = null;

/**
 * MPRIS position is only accurate at the instant it is read, and we poll every
 * POLL_MS. Extrapolate with wall-clock so a line boundary is not missed by up
 * to one poll interval. Bounded by DRIFT_TOLERANCE_MS so a seek/pause does not
 * extrapolate into nonsense.
 */
function projectedPosition(track: Track): number {
    const key = `${track.artist}::${track.title}`;
    if (!lastSample || `${lastSample.artist}::${lastSample.title}` !== key) {
        lastSample = { artist: track.artist, title: track.title, position: track.position, at: Date.now() };
        return track.position;
    }

    const elapsed = Date.now() - lastSample.at;
    const drift = track.position - lastSample.position;

    // Re-sync the anchor whenever MPRIS reports a value that disagrees with our
    // projection (seek, pause/resume) rather than trusting a stale anchor.
    if (Math.abs(drift - elapsed) > DRIFT_TOLERANCE_MS) {
        lastSample = { artist: track.artist, title: track.title, position: track.position, at: Date.now() };
        return track.position;
    }

    lastSample = { artist: track.artist, title: track.title, position: track.position, at: Date.now() };
    return track.position + elapsed;
}

async function tick() {
    if (!settings.store.enabled) return;

    const track = await readTrack();
    if (!track) {
        if (engaged) await restoreStatus();
        return;
    }

    if (!track.playing) {
        if (engaged) await restoreStatus();
        return;
    }

    await captureOwnStatus();

    const trackKey = `${track.artist}::${track.title}`;
    const changed = trackKey !== currentTrackKey;
    currentTrackKey = trackKey;

    const lyrics = await getLyrics(track);

    // Line selection uses the extrapolated position, not the raw MPRIS sample.
    const playPos = projectedPosition(track);

    let text: string | null = null;

    if (lyrics.lines?.length) {
        const line = lineAt(lyrics.lines, playPos);
        if (line && line.text.trim().length >= settings.store.minLineLength) {
            text = settings.store.prefix + line.text.trim() + settings.store.suffix;
        }
        // Lyrics exist but we're before the first line (instrumental intro) or
        // between short lines: leave the status alone rather than falling back
        // to the track title. The fallback is only for tracks with NO lyrics.
    } else if (settings.store.showTrackWhenNoLyrics) {
        // Instruments and covers-only tracks get the title instead of nothing.
        text = `♪ ${track.artist} - ${track.title}`;
    }

    if (settings.store.debug) {
        console.log(
            `[SpotifyLyricsStatus] ${track.artist} - ${track.title} @${track.position}ms ` +
            `[${lyrics.source ?? "?"}/${lyrics.lines?.length ?? 0} lines] -> ${text ?? "(no change)"}` +
            `${changed ? " [track changed]" : ""}`
        );
    }

    if (text) writeStatus(text);
}

/* ------------------------------------------------------------------ *
 * Plugin definition
 * ------------------------------------------------------------------ */

export default definePlugin({
    name: "SpotifyLyricsStatus",
    description: "Shows the current lyric line of your Spotify track as your Discord custom status.",
    authors: [{ name: "Onyx", id: 0n }],
    settings,

    start() {
        engaged = false;
        lastWritten = null;
        lastWriteAt = 0;
        currentTrackKey = "";
        lastSample = null;
        pendingText = null;
        lyricsCache = new Map();

        tick().catch(() => { });
        pollTimer = setInterval(() => { tick().catch(() => { }); }, POLL_MS);
    },

    stop() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = undefined;
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = undefined;
        pendingText = null;
        lastSample = null;
        // Don't leave the user's status hijacked by a dead plugin.
        restoreStatus().catch(() => { });
        lyricsCache = new Map();
    },
});
