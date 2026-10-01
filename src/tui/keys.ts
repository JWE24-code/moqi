/**
 * Key decoding for raw-mode stdin.
 *
 * Node hands the app raw bytes, so escape sequences have to be turned back
 * into key names. The decoder is chunk-tolerant: a sequence split across two
 * reads is held until it completes rather than being reported as a stray
 * escape.
 * @module
 */

/** One decoded keypress. */
export interface Key {
  /** Canonical name, e.g. `enter`, `up`, `ctrl+c`, `a`. */
  name: string
  /** Printable text this key contributes, if any. */
  text: string
  /**
   * Screen cell a mouse event landed on, 0-indexed. Present only on the keys
   * a mouse produces (`click`, `wheelup`, `wheeldown`) — a click is useless
   * without its target, and the wheel carries one so a later region-aware
   * wheel needs no second parser.
   */
  mouse?: { column: number; row: number }
}

const ESC = '\x1b'

/** CSI final bytes mapped to key names. */
const CSI_NAMES: Record<string, string> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
}

/** `ESC [ n ~` tilde codes mapped to key names. */
const TILDE_NAMES: Record<string, string> = {
  '1': 'home',
  '2': 'insert',
  '3': 'delete',
  '4': 'end',
  '5': 'pageup',
  '6': 'pagedown',
  '7': 'home',
  '8': 'end',
  // Enter as a tilde code, so terminals speaking CSI-u can report
  // ctrl+enter (`ESC [ 13;5 ~`) as its own chord.
  '13': 'enter',
}

/**
 * Key names for the codepoints the extended keyboard encodings report.
 *
 * xterm's modifyOtherKeys (`ESC [ 27 ; modifier ; codepoint ~`) and CSI-u
 * (`ESC [ codepoint ; modifier u`) both spell a key as its Unicode codepoint,
 * so the names have to be looked up from the number rather than the final
 * byte. Only the keys this app binds are translated; any other codepoint is
 * dropped rather than typed, so an unknown sequence can never reach the
 * composer.
 */
const CODEPOINT_NAMES: Record<string, string> = {
  '9': 'tab',
  '13': 'enter',
  '27': 'esc',
}

/** Translate one extended-encoding codepoint to a key name, if known. */
function codepointName(code: string | undefined): string | undefined {
  if (code === undefined) return undefined
  return CODEPOINT_NAMES[code]
}

/** Modifier bitmask from a CSI parameter, per the xterm convention. */
function modifiers(parameter: string | undefined): string {
  if (parameter === undefined) return ''
  const value = Number.parseInt(parameter, 10)
  if (Number.isNaN(value)) return ''
  const bits = value - 1
  let prefix = ''
  if ((bits & 1) !== 0) prefix += 'shift+'
  if ((bits & 2) !== 0) prefix += 'alt+'
  if ((bits & 4) !== 0) prefix += 'ctrl+'
  return prefix
}

/**
 * Decode a buffer into keys, returning the keys and any trailing bytes that
 * form an incomplete sequence.
 */
export function decode(input: string): { keys: Key[]; rest: string } {
  const keys: Key[] = []
  let index = 0

  while (index < input.length) {
    const char = input[index] ?? ''

    if (char === ESC) {
      const rest = input.slice(index)

      // A lone ESC at the very end may be the start of a longer sequence.
      if (rest.length === 1) return { keys, rest }

      // SGR mouse report: ESC [ < button ; column ; row (M press | m release).
      // A left-click press and the wheel are acted on; every other report is
      // swallowed so a click cannot leak into the composer as stray text.
      // Reports with modifier bits set are ignored rather than unmasked:
      // shift+click is how a terminal makes its own text selection while
      // reporting is on, and treating that workaround as an app click would
      // make copying impossible.
      if (rest.startsWith(`${ESC}[<`)) {
        const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest)
        if (mouse === null) {
          if (rest.length < 24) return { keys, rest }
          index += 1
          continue
        }
        const button = Number.parseInt(mouse[1] ?? '0', 10)
        const cell = {
          column: Number.parseInt(mouse[2] ?? '1', 10) - 1,
          row: Number.parseInt(mouse[3] ?? '1', 10) - 1,
        }
        if (mouse[4] === 'M') {
          if (button === 0) keys.push({ name: 'click', text: '', mouse: cell })
          else if (button === 64) keys.push({ name: 'wheelup', text: '', mouse: cell })
          else if (button === 65) keys.push({ name: 'wheeldown', text: '', mouse: cell })
          else if (button === 32) keys.push({ name: 'drag', text: '', mouse: cell })
        } else if (button === 0) {
          // A left-button release: the end of a drag, or the back half of a
          // click. The app tells the two apart by whether the pointer moved.
          keys.push({ name: 'release', text: '', mouse: cell })
        }
        index += mouse[0].length
        continue
      }

      // Bracketed paste: everything between the start and end markers is one
      // paste. Delivering it as a single `paste` key keeps its newlines out of
      // the submit path, and normalizing CR/CRLF to LF matches the composer's
      // own line separator. An incomplete paste is held until the terminator
      // arrives, the same way a split escape sequence is.
      if (rest.startsWith(`${ESC}[200~`)) {
        const end = rest.indexOf(`${ESC}[201~`, 6)
        if (end === -1) return { keys, rest }
        const text = rest.slice(6, end).replace(/\r\n?/g, '\n')
        keys.push({ name: 'paste', text })
        index += end + 6
        continue
      }

      if (rest[1] === '[' || rest[1] === 'O') {
        const match = new RegExp(`^${ESC}[[O]([0-9;]*)([A-Za-z~])`).exec(rest)
        if (match === null) {
          // Incomplete CSI: keep it for the next chunk, unless it is clearly junk.
          if (rest.length < 16) return { keys, rest }
          index += 1
          continue
        }
        const parameters = (match[1] ?? '').split(';')
        const final = match[2] ?? ''
        let name: string | undefined
        if (final === 'u') {
          // CSI-u (fixterms / kitty): `ESC [ codepoint ; modifier u`.
          const base = codepointName(parameters[0])
          if (base !== undefined) name = modifiers(parameters[1]) + base
        } else if (final === '~' && parameters[0] === '27' && parameters.length >= 3) {
          // xterm modifyOtherKeys: `ESC [ 27 ; modifier ; codepoint ~`, which
          // is how Ghostty and foot report ctrl+enter without the app asking
          // for the kitty protocol.
          const base = codepointName(parameters[2])
          if (base !== undefined) name = modifiers(parameters[1]) + base
        } else if (final === '~') {
          const base = TILDE_NAMES[parameters[0] ?? '']
          if (base !== undefined) name = modifiers(parameters[1]) + base
        } else {
          const base = CSI_NAMES[final]
          if (base !== undefined) name = modifiers(parameters[1]) + base
        }
        if (name !== undefined) keys.push({ name, text: '' })
        index += match[0].length
        continue
      }

      // alt+<char>
      const next = rest[1] ?? ''
      if (next >= ' ' && next <= '~') {
        keys.push({ name: `alt+${next.toLowerCase()}`, text: '' })
        index += 2
        continue
      }

      keys.push({ name: 'esc', text: '' })
      index += 1
      continue
    }

    const code = char.codePointAt(0) ?? 0

    if (char === '\r') {
      // Return submits. A line feed is Ctrl+J, so it deliberately falls
      // through to the ctrl+<letter> branch below and stays a newline.
      keys.push({ name: 'enter', text: '' })
      index += 1
      continue
    }
    if (char === '\t') {
      keys.push({ name: 'tab', text: '' })
      index += 1
      continue
    }
    if (code === 127 || code === 8) {
      keys.push({ name: 'backspace', text: '' })
      index += 1
      continue
    }
    // Control characters map to ctrl+<letter>; ctrl+a is 0x01.
    if (code < 32) {
      const letter = String.fromCharCode(code + 96)
      keys.push({ name: `ctrl+${letter}`, text: '' })
      index += 1
      continue
    }

    const point = String.fromCodePoint(code)
    keys.push({ name: point, text: point })
    index += point.length
  }

  return { keys, rest: '' }
}

/**
 * How long a lone escape waits for the rest of a sequence before it is read as
 * the escape key.
 *
 * A terminal sends the same byte for "the user pressed Escape" and for the
 * first byte of `ESC [ A`; only time tells them apart. Without this, a lone
 * Escape produced no key at all and the *next* keystroke was misread as an
 * `alt+` chord, so every documented `esc` — interrupt, close an overlay,
 * dismiss a menu — was dead. Vim's own `ttimeoutlen` sits in this range.
 */
export const ESCAPE_DELAY_MS = 50

/** A stateful decoder, plus the handles a terminal loop needs to own it. */
export interface KeyDecoder {
  /** Decode one chunk; complete keys come back, an unfinished tail is held. */
  (chunk: string): Key[]
  /** Read a held lone escape now, as its own key. */
  flush(): void
  /** Cancel any pending timer, so a stopped screen emits nothing more. */
  dispose(): void
}

/**
 * A stateful decoder that carries an incomplete sequence between chunks.
 *
 * @param emit - receives a key that arrives asynchronously (a flushed lone
 *   escape), because no further chunk will carry it.
 * @param escapeDelayMs - how long a lone escape waits; see {@link ESCAPE_DELAY_MS}.
 */
export function createDecoder(
  emit?: (key: Key) => void,
  escapeDelayMs: number = ESCAPE_DELAY_MS,
): KeyDecoder {
  let pending = ''
  let timer: ReturnType<typeof setTimeout> | undefined

  const cancel = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const decoder = ((chunk: string): Key[] => {
    cancel()
    const { keys, rest } = decode(pending + chunk)
    pending = rest
    // A lone escape is ambiguous until time passes: it is either the key
    // itself or the head of a sequence whose rest has not arrived.
    if (pending === ESC && emit !== undefined) {
      timer = setTimeout(() => {
        timer = undefined
        if (pending === ESC) {
          pending = ''
          emit({ name: 'esc', text: '' })
        }
      }, escapeDelayMs)
      // Never hold the process open for it.
      timer.unref?.()
    }
    return keys
  }) as KeyDecoder

  decoder.flush = (): void => {
    cancel()
    if (pending === ESC) {
      pending = ''
      emit?.({ name: 'esc', text: '' })
    }
  }
  decoder.dispose = cancel
  return decoder
}
