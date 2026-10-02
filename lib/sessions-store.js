/**
 * Where the JSONL session store keeps sessions on disk, and how to remove one.
 *
 * The harness has no public delete API: storage is append-only by design and
 * the query index reconciles against the filesystem, dropping entries whose
 * session directory has gone. Deleting the directory is therefore the whole
 * operation — and the reason a session stays stored until the user asks.
 *
 * The path encoding here mirrors `dsh-session-persistence-jsonl` exactly:
 * `$DSH_HOME/sessions/<projectKey(cwd)>/<encodeSegment(id)>/`.
 * @module
 */
import { readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** The sessions root: `$DSH_HOME/sessions`, defaulting to `~/.dsh/sessions`. */
export function sessionsRoot() {
    const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh');
    return join(home, 'sessions');
}
/**
 * Encode one path segment: safe characters pass through, everything else
 * becomes `~XXXX` with the code unit in upper-case hex. `.`
 * and `..` are always escaped so a session id can never traverse.
 */
export function encodeSegment(raw) {
    if (raw.length === 0)
        throw new Error('cannot encode an empty path segment');
    if (raw === '.')
        return '~002E';
    if (raw === '..')
        return '~002E~002E';
    let out = '';
    let index = 0;
    while (index < raw.length) {
        const code = raw.codePointAt(index) ?? 0;
        const char = String.fromCodePoint(code);
        if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char))
            out += char;
        else
            out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
        index += char.length;
    }
    return out;
}
/**
 * The readable directory key for a project path. Separators fold to `-`, the
 * result is bounded to a filesystem component, and the name always carries the
 * leading `--`/trailing `--` fence so a project directory is recognizable.
 */
export function projectKey(cwd) {
    if (cwd.length === 0)
        throw new Error('cannot encode an empty project path');
    let readable = '';
    let separatorRun = false;
    let index = 0;
    while (index < cwd.length) {
        const code = cwd.codePointAt(index) ?? 0;
        const char = String.fromCodePoint(code);
        if (char === '/' || char === '\\' || char === ':') {
            if (!separatorRun)
                readable += '-';
            separatorRun = true;
        }
        else if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) {
            readable += char;
            separatorRun = false;
        }
        else {
            readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
            separatorRun = false;
        }
        index += char.length;
    }
    return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}
/** The directory one stored session owns, given the cwd it was created with. */
export function storedSessionDir(cwd, id) {
    return join(sessionsRoot(), projectKey(cwd), encodeSegment(id));
}
/**
 * Find a session's directory by id alone, scanning the project directories.
 *
 * The picker knows an id but not always the cwd it was created under, and the
 * encoded id segment is unique across projects, so a scan is both correct and
 * cheap: one `readdir` of the root plus one per project directory.
 */
export async function findStoredSessionDir(id) {
    const segment = encodeSegment(id);
    const root = sessionsRoot();
    let projects;
    try {
        projects = await readdir(root, { withFileTypes: true });
    }
    catch {
        return undefined; // no sessions root: nothing is stored
    }
    for (const entry of projects) {
        if (!entry.isDirectory())
            continue;
        const candidate = join(root, entry.name, segment);
        try {
            const contents = await readdir(candidate);
            if (contents.length > 0)
                return candidate;
        }
        catch {
            // Not in this project directory; keep scanning.
        }
    }
    return undefined;
}
/**
 * Delete a stored session from disk. The query index notices on its next
 * reconciliation pass, so the session disappears from `/resume` too.
 *
 * @returns `true` when something was removed, `false` when no such session
 *   was stored.
 */
export async function deleteStoredSession(cwd, id) {
    return removeDir(storedSessionDir(cwd, id));
}
/** Delete a session found by id through {@link findStoredSessionDir}. */
export async function deleteStoredSessionDir(dir) {
    return removeDir(dir);
}
async function removeDir(dir) {
    try {
        await rm(dir, { recursive: true });
        return true;
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT')
            return false;
        throw error;
    }
}
