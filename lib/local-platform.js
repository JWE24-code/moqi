/**
 * Bridges to the desktop around the terminal, and small pure formatters.
 *
 * The clipboard and URL helpers are best effort by design: a missing helper,
 * a sandbox with no display, or a non-zero exit is never worth interrupting
 * the app to report.
 * @module
 */
import { spawnSync } from 'node:child_process';
/**
 * Hand the text to the desktop's own clipboard helper, when there is one.
 *
 * This is the companion to OSC 52, not a replacement: the escape is what works
 * over SSH and inside tmux, where no local helper can reach the clipboard the
 * user is actually looking at. Locally the reverse holds — a Wayland
 * compositor grants clipboard ownership only against an input-focus serial, so
 * a terminal can accept the escape and still not own the selection.
 *
 * Best effort by design: a missing helper, a sandbox with no display, or a
 * helper that exits non-zero all leave OSC 52 as the result, and none of them
 * are worth interrupting a copy to report.
 */
export function copyWithLocalHelper(text) {
    const wayland = process.env['WAYLAND_DISPLAY'] !== undefined;
    const x11 = process.env['DISPLAY'] !== undefined;
    const candidates = [
        ...(wayland ? [['wl-copy', []]] : []),
        ...(x11
            ? [
                ['xclip', ['-selection', 'clipboard']],
                ['xsel', ['--clipboard', '--input']],
            ]
            : []),
        ['pbcopy', []],
    ];
    for (const [command, args] of candidates) {
        try {
            const run = spawnSync(command, args, {
                input: text,
                // The helper must never inherit the terminal: wl-copy stays resident to
                // serve the selection, and a shared stdout would corrupt the frame.
                stdio: ['pipe', 'ignore', 'ignore'],
                timeout: 2000,
            });
            if (run.error === undefined && run.status === 0)
                return true;
        }
        catch {
            // Try the next candidate.
        }
    }
    return false;
}
/**
 * Open a URL with whatever the platform's own launcher is.
 *
 * `xdg-open`/`open`/`start` all fork the real browser and return once the
 * request is handed off, not once the browser is actually up — a `spawnSync`
 * here does not stall the app waiting on one. Output is discarded the same
 * way the clipboard helper's is: the launcher must never inherit our
 * raw-mode stdio.
 */
/** The launcher command for the platform this process runs on. */
function openerFor(url) {
    if (process.platform === 'darwin')
        return ['open', [url]];
    if (process.platform === 'win32')
        return ['cmd', ['/c', 'start', '', url]];
    return ['xdg-open', [url]];
}
export function openUrlWithLocalHelper(url) {
    const [command, args] = openerFor(url);
    try {
        const run = spawnSync(command, args, { stdio: 'ignore', timeout: 3000 });
        return run.error === undefined && run.status === 0;
    }
    catch {
        return false;
    }
}
/** A filesystem-safe timestamp for export file names. */
export function timestampForFile(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return (`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
        `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`);
}
/** Map a picked image path to the media type the attachment store expects. */
export function mediaTypeOf(path) {
    const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
    if (extension === '.png')
        return 'image/png';
    if (extension === '.jpg' || extension === '.jpeg')
        return 'image/jpeg';
    if (extension === '.webp')
        return 'image/webp';
    if (extension === '.gif')
        return 'image/gif';
    return undefined;
}
/** A one-line, human-readable form of anything thrown. */
export function describeError(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
