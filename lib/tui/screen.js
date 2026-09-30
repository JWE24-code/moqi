/**
 * The terminal driver: raw mode, the alternate screen, and frame painting.
 *
 * Frames are painted line by line against the previous frame so a streaming
 * reply only rewrites the lines that actually changed. That keeps a fast token
 * stream from flickering the whole screen, which a naive full clear-and-redraw
 * does at any real terminal size.
 * @module
 */
import { createDecoder } from "./keys.js";
import { displayWidth, truncate } from "./text.js";
const ESC = '';
const ALT_SCREEN_ON = `${ESC}[?1049h`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;
/**
 * Button reporting plus SGR encoding, enabled only so the wheel can scroll the
 * transcript: the alternate screen has no terminal scrollback of its own, so
 * without this the wheel does nothing at all. Most terminals still allow text
 * selection while reporting is on by holding shift.
 */
const MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`;
const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1000l`;
/**
 * Bracketed paste: the terminal wraps a paste in `ESC [ 200 ~` … `ESC [ 201 ~`
 * so the app can tell it from typing. Without it every newline in a pasted
 * block arrives as a bare Enter, which the composer reads as a submit.
 */
const PASTE_ON = `${ESC}[?2004h`;
const PASTE_OFF = `${ESC}[?2004l`;
const CURSOR_HIDE = `${ESC}[?25l`;
const CURSOR_SHOW = `${ESC}[?25h`;
const CLEAR_ALL = `${ESC}[2J`;
const RESET_SGR = `${ESC}[0m`;
/** Move the cursor to a 1-indexed row and column. */
function moveTo(row, column) {
    return `${ESC}[${row};${column}H`;
}
/** Erase from the cursor to the end of the current line. */
const CLEAR_LINE = `${ESC}[K`;
/** Fallback geometry when the terminal reports nothing usable. */
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
/**
 * Clamp a reported terminal size to something drawable.
 *
 * A stream can report `0` as well as `undefined` — a pty opened without a
 * window size does exactly that — and `?? 80` does not catch a zero. Left
 * alone, the whole frame collapses to zero-width lines and the app paints
 * nothing but cursor moves, which looks like a hang rather than a sizing
 * problem.
 */
export function normalizeSize(columns, rows) {
    return {
        columns: columns !== undefined && columns > 0 ? columns : DEFAULT_COLUMNS,
        rows: rows !== undefined && rows > 0 ? rows : DEFAULT_ROWS,
    };
}
/**
 * Owns stdin/stdout for the lifetime of the app. Construction does not touch
 * the terminal; {@link Screen.start} does, and {@link Screen.stop} is safe to
 * call more than once so teardown paths can be blunt.
 */
export class Screen {
    previous = [];
    started = false;
    decode;
    onData;
    onResize;
    cursor;
    handlers;
    mouse;
    constructor(handlers, options = {}) {
        this.handlers = handlers;
        this.mouse = options.mouse === true;
        // The decoder emits a lone escape asynchronously — nothing else will carry
        // it — so it needs the same handler the chunk path uses.
        this.decode = createDecoder((key) => {
            this.handlers.onKey(key);
        });
        this.onData = (chunk) => {
            for (const key of this.decode(chunk.toString('utf8'))) {
                this.handlers.onKey(key);
            }
        };
        this.onResize = () => {
            // A resize invalidates every cached line: the wrap points all moved.
            this.previous = [];
            this.handlers.onResize(this.size());
        };
    }
    /** Current terminal size, with defaults for a non-TTY stdout. */
    size() {
        return normalizeSize(process.stdout.columns, process.stdout.rows);
    }
    /** Whether this process is attached to a real terminal on both ends. */
    static isInteractive() {
        return process.stdin.isTTY === true && process.stdout.isTTY === true;
    }
    /** Enter the alternate screen and begin delivering keys. */
    start() {
        if (this.started)
            return;
        this.started = true;
        if (process.stdin.isTTY === true)
            process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', this.onData);
        process.stdout.on('resize', this.onResize);
        process.stdout.write(ALT_SCREEN_ON + (this.mouse ? MOUSE_ON : '') + PASTE_ON + CURSOR_HIDE + CLEAR_ALL);
    }
    /** Restore the terminal. Safe to call repeatedly and after a failed start. */
    stop() {
        if (!this.started)
            return;
        this.started = false;
        // Drop a held escape too: after teardown no key may reach the app.
        this.decode.dispose();
        process.stdin.off('data', this.onData);
        process.stdout.off('resize', this.onResize);
        if (process.stdin.isTTY === true)
            process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write(RESET_SGR + PASTE_OFF + (this.mouse ? MOUSE_OFF : '') + CURSOR_SHOW + ALT_SCREEN_OFF);
    }
    /**
     * Place the hardware cursor on the next paint, in 0-indexed screen
     * coordinates. Passing `undefined` hides it.
     */
    setCursor(position) {
        this.cursor = position;
    }
    /**
     * Paint a frame. `frame` is the whole screen as lines; missing lines are
     * treated as blank so the caller need not pad to the window height.
     */
    paint(frame) {
        if (!this.started)
            return;
        const { columns, rows } = this.size();
        let out = '';
        for (let row = 0; row < rows; row += 1) {
            const line = frame[row] ?? '';
            const clipped = displayWidth(line) > columns ? truncate(line, columns) : line;
            if (this.previous[row] === clipped)
                continue;
            out += moveTo(row + 1, 1) + CLEAR_LINE + clipped + RESET_SGR;
            this.previous[row] = clipped;
        }
        this.previous.length = rows;
        if (this.cursor === undefined) {
            out += CURSOR_HIDE;
        }
        else {
            out += moveTo(this.cursor.row + 1, this.cursor.column + 1) + CURSOR_SHOW;
        }
        if (out !== '')
            process.stdout.write(out);
    }
    /** Drop the cached frame so the next paint rewrites every line. */
    invalidate() {
        this.previous = [];
    }
}
