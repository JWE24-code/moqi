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
export declare function copyWithLocalHelper(text: string): boolean;
/**
 * Open a URL with whatever the platform's own launcher is.
 *
 * `xdg-open`/`open`/`start` all fork the real browser and return once the
 * request is handed off, not once the browser is actually up — a `spawnSync`
 * here does not stall the app waiting on one. Output is discarded the same
 * way the clipboard helper's is: the launcher must never inherit our
 * raw-mode stdio.
 */
export declare function openUrlWithLocalHelper(url: string): boolean;
/** A filesystem-safe timestamp for export file names. */
export declare function timestampForFile(date?: Date): string;
/** Map a picked image path to the media type the attachment store expects. */
export declare function mediaTypeOf(path: string): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined;
/** A one-line, human-readable form of anything thrown. */
export declare function describeError(error: unknown): string;
