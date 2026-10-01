/**
 * Vim modal editing for the composer.
 *
 * Deliberately a small subset with exact semantics: motions (`h l 0 ^ $ w b`),
 * edits (`x X dd d$ d0 dw`), insert entries (`i I a A o O`), and `u` for undo.
 * Anything else is ignored rather than guessed at, so an unexpected key can
 * never mangle a draft.
 *
 * The composer is the only thing mutated; the app decides when to route keys
 * here, which keeps this testable as plain state.
 * @module
 */
/** How many edits `u` can walk back. */
export const VIM_UNDO_LIMIT = 100;
/**
 * Modal vim state over one composer.
 *
 * Insert mode is the default: enabling vim must not change what typing does.
 * An operator key (`d`) waits for its motion, and any key that is not a valid
 * continuation cancels it — vim's own rule, and the safe one for a draft.
 */
export class Vim {
    enabled = false;
    mode = 'insert';
    operator;
    undoStack = [];
    /** Turn modal editing on or off; disabling returns to insert mode. */
    setEnabled(enabled) {
        this.enabled = enabled;
        this.mode = 'insert';
        this.operator = undefined;
    }
    /** Whether the next key should be interpreted as a command. */
    get normal() {
        return this.enabled && this.mode === 'normal';
    }
    /** Remember the draft before an edit, so `u` can restore it. */
    snapshot(composer) {
        this.undoStack.push({ text: composer.value(), cursor: composer.position() });
        if (this.undoStack.length > VIM_UNDO_LIMIT)
            this.undoStack.shift();
    }
    /**
     * Vim's `w`: the start of the next word.
     *
     * Readline's word motion (which ctrl+right uses) stops at the END of a word,
     * so vim mode cannot borrow it without disagreeing with every vim user's
     * muscle memory.
     */
    wordForward(composer) {
        const value = composer.value();
        composer.wordRight();
        while (composer.position() < value.length && /\s/.test(value[composer.position()] ?? '')) {
            composer.right();
        }
    }
    /** Undo the last vim edit. */
    undo(composer) {
        const previous = this.undoStack.pop();
        if (previous === undefined)
            return;
        composer.adopt(previous.text, previous.cursor);
    }
    /**
     * Handle one key.
     *
     * @param name - decoded key name (`h`, `esc`, `ctrl+j`, …).
     * @param text - printable text the key carries, if any.
     * @param composer - the buffer being edited.
     */
    handle(name, text, composer) {
        if (!this.enabled)
            return 'pass';
        if (this.mode === 'insert') {
            // Escape is the one key insert mode claims; everything else types.
            if (name === 'esc') {
                this.mode = 'normal';
                this.operator = undefined;
                // Leaving insert parks the cursor where vim would: one column left.
                composer.left();
                return 'mode';
            }
            return 'pass';
        }
        // Normal mode: an operator waits for its motion.
        if (this.operator !== undefined) {
            const pending = this.operator;
            this.operator = undefined;
            switch (pending) {
                case 'd':
                    return this.deleteMotion(name, composer);
                default:
                    return 'handled';
            }
        }
        switch (name) {
            case 'esc':
                return 'handled';
            case 'h':
            case 'left':
                composer.left();
                return 'handled';
            case 'l':
            case 'right':
                composer.right();
                return 'handled';
            case '0':
            case 'home':
                composer.home();
                return 'handled';
            case '^': {
                composer.home();
                // First non-blank of the line.
                const value = composer.value();
                let at = composer.position();
                while (at < value.length && (value[at] === ' ' || value[at] === '\t')) {
                    composer.right();
                    at += 1;
                }
                return 'handled';
            }
            case '$':
            case 'end':
                composer.end();
                return 'handled';
            case 'w':
                this.wordForward(composer);
                return 'handled';
            case 'b':
                composer.wordLeft();
                return 'handled';
            case 'i':
                this.mode = 'insert';
                return 'mode';
            case 'I': {
                composer.home();
                this.mode = 'insert';
                return 'mode';
            }
            case 'a': {
                composer.right();
                this.mode = 'insert';
                return 'mode';
            }
            case 'A': {
                composer.end();
                this.mode = 'insert';
                return 'mode';
            }
            case 'o': {
                this.snapshot(composer);
                composer.end();
                composer.insert('\n');
                this.mode = 'insert';
                return 'mode';
            }
            case 'O': {
                this.snapshot(composer);
                composer.home();
                composer.insert('\n');
                composer.left();
                this.mode = 'insert';
                return 'mode';
            }
            case 'x': {
                this.snapshot(composer);
                composer.deleteForward();
                return 'handled';
            }
            case 'X': {
                this.snapshot(composer);
                composer.backspace();
                return 'handled';
            }
            case 'u':
                this.undo(composer);
                return 'handled';
            case 'd':
                this.operator = 'd';
                return 'handled';
            default:
                // Unbound keys are swallowed, as in vim: a stray `j` must not type.
                return 'handled';
        }
    }
    /** `d` plus a motion, in terms of absolute buffers offsets. */
    deleteMotion(motion, composer) {
        switch (motion) {
            case 'd': {
                this.snapshot(composer);
                const start = composer.lineStartIndex();
                const end = composer.lineEndIndex();
                // A line delete takes its newline with it, as vim's `dd` does; the
                // last line has none, so it simply shortens.
                const trailing = composer.value()[end] === '\n' ? 1 : 0;
                composer.deleteRange(start, end + trailing);
                return 'handled';
            }
            case '$': {
                this.snapshot(composer);
                composer.deleteRange(composer.position(), composer.lineEndIndex());
                return 'handled';
            }
            case '0':
            case '^': {
                this.snapshot(composer);
                composer.deleteRange(composer.lineStartIndex(), composer.position());
                return 'handled';
            }
            case 'w': {
                this.snapshot(composer);
                const before = composer.position();
                this.wordForward(composer);
                composer.deleteRange(before, composer.position());
                return 'handled';
            }
            default:
                // `d` followed by something unbound is cancelled, not guessed at.
                return 'handled';
        }
    }
}
