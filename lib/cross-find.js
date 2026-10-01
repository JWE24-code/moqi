/**
 * Cross-session search: `/find --sessions`.
 *
 * Stored sessions live under `$DSH_HOME/sessions/<projectKey>/<sessionId>/` as
 * either a plain `.jsonl` log or a zstd-compressed one. This module walks them,
 * reads whichever form it finds, and returns the matching lines with enough
 * context to recognize the conversation — no index, no cache, and nothing
 * written, so it can never corrupt a log another process is appending to.
 *
 * The zstd decoder is feature-detected: on a Node without it, compressed logs
 * are skipped and reported as such rather than silently ignored.
 * @module
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
export const DEFAULT_LIMITS = {
    maxSessions: 400,
    maxHits: 80,
    maxBytes: 4_000_000,
};
/** Whether this build of Node can decompress a zstd log. */
export function zstdAvailable() {
    return typeof zstdDecompressSync === 'function';
}
/** Extract printable message text from one JSONL record, or `''`. */
function textOfRecord(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { text: '' };
    }
    const record = parsed;
    const type = String(record.type ?? '');
    const role = type === 'user/message' ? 'user' : type === 'assistant/message' ? 'assistant' : undefined;
    if (role === undefined)
        return { text: '' };
    const blocks = record.data?.message?.content;
    if (!Array.isArray(blocks))
        return { text: '' };
    const text = blocks
        .filter((block) => {
        const candidate = block;
        return candidate.type === 'text' && typeof candidate.text === 'string';
    })
        .map((block) => block.text)
        .join(' ');
    return { text, role };
}
/**
 * Parse a whole JSONL session body into its visible messages.
 *
 * Shared by cross-session search and the fleet preview, so both read a log the
 * same way — including a foreign device's log, which may be an older format
 * whose unknown records are simply skipped.
 */
export function parseLogMessages(body) {
    const messages = [];
    for (const raw of body.split('\n')) {
        if (!raw.includes('"'))
            continue;
        const { text, role } = textOfRecord(raw);
        if (text === '' || role === undefined)
            continue;
        messages.push({ role, text });
    }
    return messages;
}
/** Whether a buffer carries the zstd frame magic. */
export function isZstdFrame(bytes) {
    return bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd;
}
/** Decode raw log bytes, whichever form they arrived in. */
export function decodeLogBytes(bytes) {
    if (!isZstdFrame(bytes))
        return Buffer.from(bytes).toString('utf8');
    if (!zstdAvailable())
        return undefined;
    try {
        return zstdDecompressSync(bytes).toString('utf8');
    }
    catch {
        return undefined;
    }
}
/** Read one log file, decompressing when it is zstd, bounded by `maxBytes`. */
function readLog(path, maxBytes) {
    let raw;
    try {
        raw = readFileSync(path);
    }
    catch {
        return undefined;
    }
    // A compressed frame cannot be decoded from a prefix, so the whole file is
    // decoded — but a log beyond the byte ceiling is skipped rather than held
    // in memory twice. A plain log has no such constraint: it truncates.
    if (path.endsWith('.zstd') && raw.byteLength > maxBytes)
        return undefined;
    return decodeLogBytes(raw.byteLength > maxBytes ? raw.subarray(0, maxBytes) : raw);
}
/** Session directories under the store root, most recently modified first. */
function sessionDirs(root) {
    const found = [];
    let projects;
    try {
        projects = readdirSync(root);
    }
    catch {
        return found;
    }
    for (const project of projects) {
        const projectDir = join(root, project);
        let entries;
        try {
            entries = readdirSync(projectDir);
        }
        catch {
            continue;
        }
        for (const id of entries) {
            if (!id.startsWith('session-'))
                continue;
            const dir = join(projectDir, id);
            try {
                if (!statSync(dir).isDirectory())
                    continue;
                found.push({ project, dir, id, mtime: statSync(dir).mtimeMs });
            }
            catch {
                continue;
            }
        }
    }
    found.sort((a, b) => b.mtime - a.mtime);
    return found;
}
/** The log file inside a session directory, whichever format it is. */
function logFile(dir) {
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return undefined;
    }
    const zstd = entries.find((name) => name.endsWith('.jsonl.zstd'));
    if (zstd !== undefined)
        return join(dir, zstd);
    const plain = entries.find((name) => name.endsWith('.jsonl'));
    return plain === undefined ? undefined : join(dir, plain);
}
/**
 * Search every stored session for a case-insensitive substring.
 *
 * @returns matching lines in session order (newest session first), capped by
 *   the limits. Skipped compressed logs on a Node without zstd mean fewer
 *   results, never wrong ones.
 */
export function searchSessions(root, query, limits = DEFAULT_LIMITS) {
    const needle = query.trim().toLowerCase();
    if (needle === '')
        return { hits: [], scanned: 0, skippedCompressed: 0 };
    const hits = [];
    let scanned = 0;
    let skippedCompressed = 0;
    for (const candidate of sessionDirs(root)) {
        if (scanned >= limits.maxSessions || hits.length >= limits.maxHits)
            break;
        const path = logFile(candidate.dir);
        if (path === undefined)
            continue;
        if (path.endsWith('.zstd') && !zstdAvailable()) {
            skippedCompressed += 1;
            continue;
        }
        const body = readLog(path, limits.maxBytes);
        if (body === undefined)
            continue;
        scanned += 1;
        for (const raw of body.split('\n')) {
            if (hits.length >= limits.maxHits)
                break;
            if (!raw.includes('"'))
                continue;
            const { text, role } = textOfRecord(raw);
            if (text === '')
                continue;
            const context = text.replace(/\s+/g, ' ').trim();
            const index = context.toLowerCase().indexOf(needle);
            if (index === -1)
                continue;
            const at = Math.max(index - 30, 0);
            const snippet = context.slice(at, at + 140);
            hits.push({
                sessionId: candidate.id,
                project: candidate.project.replace(/^--|--$/g, ''),
                line: at > 0 ? `…${snippet}` : snippet,
                ...(role === undefined ? {} : { role }),
                path,
            });
        }
    }
    return { hits, scanned, skippedCompressed };
}
