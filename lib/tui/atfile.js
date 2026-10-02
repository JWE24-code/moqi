/**
 * `@` file completion: token detection, fuzzy filtering, and the inline menu.
 *
 * Like the rest of `tui/`, this module knows nothing about the terminal or the
 * Harness — it turns composer text plus a candidate list into a menu state, so
 * the interaction rules stay testable on their own.
 * @module
 */
import { fuzzyMatch } from "./state.js";
/** Raster formats the Harness attachment service admits. */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
/** Whether a path names an image the composer can stage as an attachment. */
export function isImagePath(path) {
    const dot = path.lastIndexOf('.');
    if (dot === -1)
        return false;
    const extension = path.slice(dot).toLowerCase();
    return IMAGE_EXTENSIONS.includes(extension);
}
/** Directories a workspace walk never descends into. */
export const SKIP_DIRECTORIES = new Set([
    'node_modules',
    '.git',
    '.hg',
    '.svn',
    'dist',
    'lib',
    'build',
    'out',
    'coverage',
    '.cache',
    '.venv',
    '__pycache__',
    '.DS_Store',
]);
/**
 * The `@` token being typed at the cursor, if any.
 *
 * A token counts only when the `@` sits at a token boundary — the start of
 * the text or right after whitespace — so an email address in prose
 * (`user@host`) or a social handle never opens the menu. The query is what
 * follows the `@` up to the cursor; a query containing `/` is path-shaped and
 * lists one directory rather than fuzzy-matching the whole workspace.
 */
export function activeAtToken(text, cursor) {
    // Walk back over the token the cursor sits in.
    let start = cursor;
    while (start > 0 && !/[\s]/.test(text[start - 1] ?? ''))
        start -= 1;
    if (text[start] !== '@')
        return undefined;
    const query = text.slice(start + 1, cursor);
    // A space has been typed after the token: the user has moved on.
    if (/[\n]/.test(query))
        return undefined;
    return { query, start };
}
/**
 * Whether a query names a directory rather than fuzzy-matching the workspace:
 * anything containing a separator (`src/`, `../lib`, `~/notes`).
 */
export function isPathShaped(query) {
    return query.includes('/');
}
/**
 * Rank candidates for a plain (non-path-shaped) query.
 *
 * Every path must contain the query as a subsequence, the same filter the
 * model picker uses; shallower and shorter paths win so `state` finds
 * `src/tui/state.ts` before `tests/theme-state-fixture.ts`.
 */
export function filterFiles(query, paths, limit = 200) {
    const normalized = query.toLowerCase();
    const scored = [];
    for (const path of paths) {
        if (!fuzzyMatch(normalized, path.toLowerCase()))
            continue;
        const depth = path.split('/').length;
        scored.push({ path, score: depth * 1000 + path.length });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, limit).map(({ path }) => ({ path, directory: false }));
}
/**
 * The inline completion menu over the active `@` token.
 *
 * It follows the composer rather than owning the keyboard: typing keeps
 * filtering, `↑`/`↓` (or ctrl+p/n) move, `tab`/`enter` accept, `esc` dismisses
 * — and only the menu closes, not anything layered beneath it.
 */
export class AtMenu {
    open = false;
    matches = [];
    selected = 0;
    /** The token the menu is showing matches for; a change reopens it. */
    query = '';
    /** Recompute from the active token. `dismissed` is the token the user pressed esc on. */
    update(token, candidates, dismissed) {
        if (token === undefined || token.query === dismissed) {
            this.close();
            return;
        }
        this.query = token.query;
        this.matches = [...candidates];
        this.selected = 0;
        this.open = this.matches.length > 0;
    }
    move(delta) {
        if (!this.open || this.matches.length === 0)
            return;
        this.selected = Math.min(Math.max(this.selected + delta, 0), this.matches.length - 1);
    }
    current() {
        if (!this.open)
            return undefined;
        return this.matches[this.selected];
    }
    close() {
        this.open = false;
        this.matches = [];
        this.selected = 0;
        this.query = '';
    }
}
/**
 * Replace the token a menu pick stands for with the accepted path.
 *
 * Returns the new composer text and cursor: the `@` and everything typed
 * after it up to the cursor give way to the path plus a trailing space, so
 * the next word starts cleanly. Whatever followed the cursor stays.
 */
export function acceptToken(text, cursor, token, path) {
    const before = text.slice(0, token.start);
    const after = text.slice(cursor);
    const inserted = `${path} `;
    return { text: before + inserted + after, cursor: before.length + inserted.length };
}
/**
 * Extract `[Image #N name]` tokens from a draft.
 *
 * Returns the text with the tokens stripped and the numbers in order, so the
 * sender can pair them with staged attachment references. A token the user
 * deleted leaves no trace: unmatched staged images are dropped at send.
 */
export function extractImageTokens(text) {
    const numbers = [];
    const stripped = withoutImageTokens(text, numbers);
    // Tidy the doubled spaces removal can leave behind.
    const cleaned = stripped.replace(/ {2,}/g, ' ').replace(/^[ \t]+/gm, '').replace(/[ \t]+$/gm, '');
    return { text: cleaned, numbers };
}
/**
 * Remove every `[Image #n …]` token, collecting the n in order. Scanned by
 * hand rather than by one greedy regex: `\d+` and `[^\]]*` both match
 * digits, and the backtracking between them is what the slow-regex rule
 * flags.
 */
function withoutImageTokens(text, numbers) {
    const head = '[Image #';
    let out = '';
    let at = 0;
    while (at < text.length) {
        const open = text.indexOf(head, at);
        if (open === -1)
            return out + text.slice(at);
        let digitsEnd = open + head.length;
        while ((text[digitsEnd] ?? '') >= '0' && (text[digitsEnd] ?? '') <= '9')
            digitsEnd += 1;
        const close = text.indexOf(']', digitsEnd);
        if (digitsEnd === open + head.length || close === -1) {
            // Not an image token after all: keep the bracket and move past it.
            out += text.slice(at, digitsEnd);
            at = digitsEnd;
            continue;
        }
        out += text.slice(at, open);
        numbers.push(Number.parseInt(text.slice(open + head.length, digitsEnd), 10));
        at = close + 1;
    }
    return out;
}
