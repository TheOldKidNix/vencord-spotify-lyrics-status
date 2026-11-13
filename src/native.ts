/*
 * Vencord, a Discord client mod
 * SpotifyLyricsStatus - main process side.
 *
 * Two jobs:
 *   1. Read the playing Spotify track over MPRIS (playerctl).
 *   2. Fetch synced lyrics from LRCLIB.
 *
 * Both live in the main process because the renderer is sandboxed: Discord's
 * Content-Security-Policy blocks outbound fetch() to lrclib.net (it fails with
 * "TypeError: Failed to fetch"), and the renderer has no child_process access
 * to run playerctl.
 *
 * Vencord discovers these handlers automatically: every exported function
 * becomes VencordNative.pluginHelpers.SpotifyLyricsStatus.<name> in the
 * renderer (via the VencordGetPluginIpcMethodMap handshake).
 */

import { execFile } from "child_process";
import { request as httpsRequest, Agent } from "node:https";
import { createHash } from "node:crypto";

/** Called by name via execFile - no shell, so no quoting/injection surface. */
const PLAYERCTL = "playerctl";
const PLAYER = "spotify";

/**
 * Fallback providers get a hard time budget. A full chain miss was measured at
 * ~7s because each provider makes two or three sequential requests; that is
 * long enough to be felt when the track changes. Whichever provider has not
 * answered by DEADLINE_MS is abandoned and the chain returns "no lyrics".
 */
const CHAIN_DEADLINE_MS = 2_000;

const LRCLIB_GET = "https://lrclib.net/api/get";
const LRCLIB_SEARCH = "https://lrclib.net/api/search";
const USER_AGENT = "SpotifyLyricsStatus/1.0 (Vencord userplugin)";
const HTTP_TIMEOUT_MS = 4_000;

export interface TrackInfo {
    artist: string;
    title: string;
    /** Spotify track id, from the MPRIS trackid — needed by the Spicy Lyrics API */
    id?: string;
    /** playback position, milliseconds */
    position: number;
    /** total length, milliseconds */
    length: number;
    playing: boolean;
}

export interface LyricLine {
    /** ms from track start */
    time: number;
    text: string;
}

export interface LyricsResult {
    lines: LyricLine[] | null;
    instrumental: boolean;
    /** false when every lookup errored, so the caller retries soon */
    ok: boolean;
    /** which provider supplied the lines, for the debug log */
    source?: "spicy" | "lrclib" | "netease" | "kugou" | "none";
}

function run(args: string[], timeout = 2500): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(PLAYERCTL, args, { timeout, maxBuffer: 64 * 1024 }, (err, stdout) => {
            if (err) return reject(err);
            resolve(stdout);
        });
    });
}

/**
 * MPRIS reports position and length in microseconds; we normalise to ms.
 * A single playerctl call fetches everything to avoid four round-trips per poll.
 */
export async function getTrack(_event?: unknown): Promise<TrackInfo | null> {
    try {
        const format = "{{xesam:artist}}\n{{xesam:title}}\n{{position}}\n{{mpris:length}}\n{{status}}\n{{mpris:trackid}}";
        const out = await run(["-p", PLAYER, "metadata", "--format", format]);
        const lines = out.split("\n");
        if (lines.length < 5) return null;

        const artist = (lines[0] ?? "").trim();
        const title = (lines[1] ?? "").trim();
        const positionUs = Number((lines[2] ?? "").trim());
        const lengthUs = Number((lines[3] ?? "").trim());
        const status = (lines[4] ?? "").trim();
        // trackid looks like /com/spotify/track/<id>; keep just the id
        const rawId = (lines[5] ?? "").trim();
        const id = rawId.includes("/") ? rawId.slice(rawId.lastIndexOf("/") + 1) : rawId;

        if (!title) return null;

        return {
            artist,
            title,
            id: id || undefined,
            position: Number.isFinite(positionUs) ? Math.round(positionUs / 1000) : 0,
            length: Number.isFinite(lengthUs) ? Math.round(lengthUs / 1000) : 0,
            playing: status === "Playing",
        };
    } catch {
        // playerctl exits non-zero when nothing is playing - not an error.
        return null;
    }
}

/* ------------------------------------------------------------------ *
 * Lyrics
 * ------------------------------------------------------------------ */

/** Parse an LRC document into sorted {(ms, text)} pairs. */
function parseLrc(lrc: string): LyricLine[] {
    const out: LyricLine[] = [];
    for (const raw of lrc.split("\n")) {
        const m = raw.match(/^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\](.*)$/);
        if (!m) continue;
        const min = Number(m[1]);
        const sec = Number(m[2]);
        const fracRaw = m[3] ?? "0";
        // centiseconds (2 digits) vs milliseconds (3 digits)
        const frac = fracRaw.length === 3 ? Number(fracRaw) : Number(fracRaw.padEnd(2, "0")) * 10;
        const text = m[4].trim();
        if (!text) continue;
        out.push({ time: min * 60_000 + sec * 1000 + frac, text });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
}

/**
 * Use node:https rather than the global fetch(). In Electron's main process
 * fetch() is wired to a Session/network stack that silently fails for these
 * requests (returns no response at all), whereas node:https is plain Node.
 */
/** Hosts that serve a CDN certificate not matching their own name. */
const RELAXED_HOSTNAME_HOSTS = ["mobilecdn.kugou.com", "krcs.kugou.com", "lyrics.kugou.com"];

/**
 * Agent that validates the certificate chain but not the hostname. Only used
 * for kugou's CDN-fronted hosts (see the Kugou comment block). Chain validation
 * is deliberately left on: a self-signed or untrusted cert is still refused.
 */
const relaxedHostnameAgent = new Agent({ rejectUnauthorized: true, checkServerIdentity: () => undefined } as any);

function needsRelaxedHostname(url: string): boolean {
    try {
        const h = new URL(url).hostname;
        return RELAXED_HOSTNAME_HOSTS.includes(h);
    } catch {
        return false;
    }
}

function httpText(url: string, extraHeaders?: Record<string, string>): Promise<{ status: number; body: string } | null> {
    return new Promise(resolve => {
        let req: any;
        try {
            req = httpsRequest(url, {
                method: "GET",
                headers: {
                    "User-Agent": USER_AGENT,
                    Accept: "application/json",
                    ...extraHeaders,
                },
                timeout: HTTP_TIMEOUT_MS,
                family: 4,
                ...(needsRelaxedHostname(url) ? { agent: relaxedHostnameAgent } : {}),
            } as any, (res: any) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    return resolve({ status: res.statusCode, body: "" });
                }
                let body = "";
                res.setEncoding("utf8");
                res.on("data", (c: string) => { body += c; });
                res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
            });
        } catch {
            return resolve(null);
        }

        req.on("timeout", () => {
            req.destroy();
            resolve(null);
        });
        req.on("error", () => resolve(null));
        req.end();
    });
}

/** Run a provider but give up after `ms`, so one slow source cannot stall playback. */
function withDeadline<T>(work: Promise<T | null>, ms: number, fallbackLabel: string): Promise<T | null> {
    return new Promise(resolve => {
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                (globalThis as any).__slsChainTimeout = fallbackLabel;
                resolve(null);
            }
        }, ms);
        work.then(v => {
            if (!settled) { settled = true; clearTimeout(timer); resolve(v); }
        }).catch(() => {
            if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
        });
    });
}

/** Convenience: GET returning parsed JSON, or null on any non-200/parse failure. */
async function httpJson(url: string, extraHeaders?: Record<string, string>): Promise<any | null> {
    const r = await httpText(url, extraHeaders);
    if (!r || r.status !== 200 || !r.body) return null;
    try { return JSON.parse(r.body); } catch { return null; }
}

function interpret(data: any): LyricsResult | null {
    if (!data) return null;
    if (data.instrumental) return { lines: null, instrumental: true, ok: true, source: "lrclib" };
    if (typeof data.syncedLyrics === "string") {
        const lines = parseLrc(data.syncedLyrics);
        if (lines.length) return { lines, instrumental: false, ok: true, source: "lrclib" };
    }
    return null;
}


/* ------------------------------------------------------------------ *
 * Fallback lyric providers
 *
 * LRCLIB alone measures ~78% coverage on real listening (11/14 tracks).
 * NetEase covers most of the rest (85%), so it runs as the single fallback
 * and the pair reaches ~92% on the same sample.
 *
 * Considered and rejected:
 *   QQ Music  -- /lyric endpoint now answers retcode -1901 (anti-bot) for
 *                every request; it worked once and then stopped.
 *   Kugou     -- works, but requires disabling TLS verification (its cert
 *                chain fails validation) and happily returns a DIFFERENT
 *                artist's song with the same title. Not worth the risk.
 *   Apple     -- needs a signed developer token; no public flow.
 *
 * Both remaining sources are keyed by free-text search, so results are
 * verified against the exact expected artist+title before being used:
 * mismatched lyrics are worse than none.
 * ------------------------------------------------------------------ */

const CN_HEADERS = { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36" };

function normalise(s: string): string {
    return s
        .toLowerCase()
        .replace(/\s*[([].*?[)\]]\s*/g, " ")   // strip "(feat. X)", "[Remastered]"
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

/**
 * Verify a search hit really is the track we are playing.
 *
 * This is strict on purpose. NetEase's catalogue contains many songs with
 * identical titles by different artists; accepting the first title match
 * produced lyrics for an unrelated song during testing, which is a worse
 * outcome than showing nothing.
 */
function titleLooksRight(wantTitle: string, wantArtist: string, gotTitle: string, gotArtist: string): boolean {
    const wt = normalise(wantTitle);
    const gt = normalise(gotTitle);
    const wa = normalise(wantArtist);
    const ga = normalise(gotArtist);

    if (!wt || !gt || !wa) return false;

    // Title must match closely: equal, or one contains the other.
    const titleOk = gt === wt || gt.includes(wt) || wt.includes(gt);
    if (!titleOk) return false;

    // Artist must match on at least one significant (>2 char) token.
    const wantTokens = wa.split(" ").filter(t => t.length > 2);
    const gotTokens = new Set(ga.split(" ").filter(t => t.length > 2));
    if (!wantTokens.length) return false;

    return wantTokens.some(t => gotTokens.has(t));
}

/**
 * Score how well a candidate's length matches ours.
 *
 * Duration is a RANKING signal, not a gate. Providers disagree constantly on
 * track length (radio edits, vinyl masters, re-uploads, and plain bad metadata):
 * kugou reported 175s for a track MPRIS gave as 270s, and a hard filter would
 * have thrown away perfectly good lyrics. So: prefer the closest length, but
 * never reject outright on length alone -- artist+title already had to match.
 */
function durationScore(wantSec: number, gotSec: number | undefined): number {
    if (!gotSec || !wantSec) return 0;
    return Math.abs(gotSec - wantSec);
}

/** NetEase Cloud Music: free search + per-song LRC. Fills underground gaps. */
async function neteaseLyrics(artist: string, title: string, durationSec: number): Promise<LyricLine[] | null> {
    const q = encodeURIComponent(`${artist} ${title}`);
    const search = await httpJson(
        `https://music.163.com/api/search/get?s=${q}&type=1&limit=8`,
        { ...CN_HEADERS, Referer: "https://music.163.com" }
    );
    const songs = search?.result?.songs;
    if (!Array.isArray(songs)) return null;

    // Prefer the closest length among title+artist matches.
    const candidates = songs
        .filter((s: any) => {
            const songArtist = (s?.artists ?? []).map((x: any) => x?.name).filter(Boolean).join(" ");
            return titleLooksRight(title, artist, s?.name ?? "", songArtist);
        })
        .sort((a: any, b: any) =>
            durationScore(durationSec, (a?.duration ?? 0) / 1000) -
            durationScore(durationSec, (b?.duration ?? 0) / 1000))
        .slice(0, 3);

    for (const s of candidates) {

        const lyr = await httpJson(
            `https://music.163.com/api/song/lyric?id=${s.id}&lv=1&kv=1`,
            { ...CN_HEADERS, Referer: "https://music.163.com" }
        );
        const lrc: string | undefined = lyr?.lrc?.lyric;
        if (lrc && lrc.includes("[")) {
            const lines = parseLrc(lrc);
            if (lines.length) return lines;
        }
    }
    return null;
}



/*
 * Kugou
 * ------
 * Measured as the strongest single provider here: 39/39 on a genre-spanning
 * sample vs 84.6% for LRCLIB and 82.1% for NetEase. Two steps: search by text,
 * then exchange the result's hash for a download ticket and fetch the LRC.
 *
 * TLS note: kugou's media hosts are fronted by a Tencent CDN and serve a
 * certificate whose SAN is *.cdn.myqcloud.com, so hostname verification fails
 * even though the chain is valid. We relax ONLY hostname matching for these
 * requests (reqOptions in httpText); chain validation stays on -- a
 * self-signed certificate is still rejected.
 */
async function kugouLyrics(artist: string, title: string, durationSec: number): Promise<LyricLine[] | null> {
    const q = encodeURIComponent(`${artist} ${title}`);
    const search = await httpJson(
        `https://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${q}&page=1&pagesize=8&showtype=1`,
        CN_HEADERS
    );
    const info = search?.data?.info;
    if (!Array.isArray(info)) return null;

    // kugou reports duration in seconds; rank by closeness, never reject on it.
    const kCandidates = info
        .filter((s: any) => titleLooksRight(title, artist, s?.songname ?? "", s?.singername ?? ""))
        .sort((a: any, b: any) =>
            durationScore(durationSec, a?.duration) - durationScore(durationSec, b?.duration))
        .slice(0, 3);

    for (const s of kCandidates) {
        const hash = s?.hash;
        if (!hash) continue;

        const cand = await httpJson(
            `https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&duration=&hash=${hash}`,
            CN_HEADERS
        );
        const c = cand?.candidates?.[0];
        if (!c?.id || !c?.accesskey) continue;

        const dl = await httpJson(
            `https://lyrics.kugou.com/download?ver=1&client=pc&id=${c.id}&accesskey=${c.accesskey}&fmt=lrc&charset=utf8`,
            CN_HEADERS
        );
        const b64: string | undefined = dl?.content;
        if (!b64) continue;

        let lrc: string;
        try {
            lrc = Buffer.from(b64, "base64").toString("utf8");
        } catch { continue; }

        if (lrc.includes("[")) {
            const lines = parseLrc(lrc);
            if (lines.length) return lines;
        }
    }
    return null;
}


/*
 * Spicy Lyrics developer API  (https://developers.spicylyrics.org)
 * -----------------------------------------------------------------
 * Preferred source when a key is configured. One request returns the best
 * sync available for a Spotify track, chosen by the provider's own hierarchy:
 *
 *   1. community sync (human-made, usually most precise, often word-level)
 *   2. Apple Music
 *   3. Spotify
 *
 * That is strictly better than scraping three free catalogues ourselves: it
 * reaches community + Apple Music material we cannot otherwise get, and it
 * reports the sync precision in `Type` ("Syllable" = word-level).
 *
 * Two request shapes are supported:
 *   GET  /v1/lyrics/{spotifyId}        with Authorization: Bearer <key>
 *   POST /v1/lyrics                    with the id in the JSON body
 *
 * The key is read from config (plugin setting). It is a *secret* key, so this
 * only ever runs in the main process and is never sent to the renderer.
 */

const SPICY_BASE = "https://api.spicylyrics.org";

/** Subset of the response we care about. */
interface SpicyLine {
    Text?: string;
    OppositeAlignedWords?: { Text?: string }[];
    Syllables?: { Text?: string }[];
    StartTime?: number;
    EndTime?: number;
}

/** Flatten a Spicy Lyrics line of any sync type into plain text. */
function spicyLineText(l: SpicyLine): string {
    if (typeof l.Text === "string" && l.Text.trim()) return l.Text.trim();
    if (Array.isArray(l.Syllables)) return l.Syllables.map(s => s?.Text ?? "").join("").trim();
    if (Array.isArray(l.OppositeAlignedWords)) return l.OppositeAlignedWords.map(s => s?.Text ?? "").join("").trim();
    return "";
}

/**
 * Convert the Spicy Lyrics payload into our (ms, text) line model.
 *
 * StartTime on each line is in SECONDS. The response is an array of line
 * objects; each may carry `Lead.Syllables` for word-level syncs.
 */
function parseSpicy(body: any): LyricLine[] {
    const content = body?.Content;
    if (!Array.isArray(content)) return [];

    const out: LyricLine[] = [];
    for (const raw of content) {
        const line: SpicyLine = raw?.Lead ?? raw ?? {};
        const text = spicyLineText(line);
        if (!text) continue;
        const start = Number(line.StartTime);
        if (!Number.isFinite(start)) continue;
        out.push({ time: Math.round(start * 1000), text });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
}

/** Ask Spicy Lyrics for the best sync of a Spotify track id. */
async function spicyLyrics(trackId: string, apiKey: string): Promise<LyricLine[] | null> {
    if (!trackId || !apiKey) return null;

    const res = await httpJson(
        `${SPICY_BASE}/v1/lyrics/${encodeURIComponent(trackId)}`,
        { Authorization: `Bearer ${apiKey}` }
    );

    if (!res) return null;

    // Documented failures come back as {Body:{error,message},Status}
    if (res?.Status && res.Status !== 200) return null;

    const lines = parseSpicy(res?.Body);
    return lines.length ? lines : null;
}

/**
 * Look a track up on LRCLIB: exact /api/get first, then /api/search scored by
 * duration so a remaster or live cut doesn't pair with the wrong lyrics.
 */
export async function fetchLyrics(
    _event: unknown,
    artist: string,
    title: string,
    durationSec: number,
    trackId?: string,
    spicyKey?: string
): Promise<LyricsResult> {
    // Preferred: Spicy Lyrics (community + Apple Music + Spotify in one call).
    // Runs first when a key is configured; silently skipped otherwise.
    if (spicyKey) {
        try {
            const sp = await withDeadline(spicyLyrics(trackId ?? "", spicyKey), CHAIN_DEADLINE_MS, "spicy");
            if (sp?.length) return { lines: sp, instrumental: false, ok: true, source: "spicy" };
        } catch { /* fall through */ }
    }

    let sawResponse = false;

    const getUrl = new URL(LRCLIB_GET);
    getUrl.searchParams.set("artist_name", artist);
    getUrl.searchParams.set("track_name", title);
    if (durationSec > 0) getUrl.searchParams.set("duration", String(Math.round(durationSec)));

    const exact = await httpJson(getUrl.toString());
    if (exact !== null) {
        sawResponse = true;
        const hit = interpret(exact);
        if (hit) return hit;
    }

    const searchUrl = new URL(LRCLIB_SEARCH);
    searchUrl.searchParams.set("artist_name", artist);
    searchUrl.searchParams.set("track_name", title);

    // LRCLIB's /search response is large and slow (~2-3s on a miss). Cap it so a
    // miss here does not consume the whole chain budget before fallbacks run.
    const found = await withDeadline(httpJson(searchUrl.toString()), 1_800, "lrclib-search");
    if (Array.isArray(found)) {
        sawResponse = true;
        const scored = found
            .filter(r => typeof r?.syncedLyrics === "string" || r?.instrumental)
            .map(r => ({ r, delta: Math.abs(Number(r.duration ?? 0) - durationSec) }))
            .sort((a, b) => a.delta - b.delta);

        for (const { r, delta } of scored) {
            // Wrong-song lyrics are worse than none: reject >8s duration drift.
            if (delta > 8) continue;
            const hit = interpret(r);
            if (hit) return hit;
        }
    }

    // --- fallback providers, raced in PARALLEL ---
    //
    // Serially they stack: a full miss cost ~4s (NetEase budget + Kugou budget
    // back to back) which is long enough to be felt when a track changes.
    // Racing them means the total is the slowest single provider, not the sum.
    // Both are keyed by free-text search and verified before use, so a result
    // arriving from either is equally trustworthy; NetEase wins ties only
    // because it is marginally faster when it has the track.
    const [ne, kg] = await Promise.all([
        withDeadline(neteaseLyrics(artist, title, durationSec), CHAIN_DEADLINE_MS, "netease"),
        withDeadline(kugouLyrics(artist, title, durationSec), CHAIN_DEADLINE_MS, "kugou"),
    ]);

    if (ne?.length) return { lines: ne, instrumental: false, ok: true, source: "netease" };
    if (kg?.length) return { lines: kg, instrumental: false, ok: true, source: "kugou" };

    // If at least one endpoint answered, this is a definitive "no lyrics".
    // Otherwise it was transient and `ok: false` makes the caller retry soon.
    return { lines: null, instrumental: false, ok: sawResponse, source: "none" };
}


