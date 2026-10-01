/**
 * OSC 52 smoke: the clipboard sequence itself, and getting it through tmux
 * or GNU screen — the gap that a raw, unwrapped OSC 52 leaves inside either
 * multiplexer, silently swallowed rather than reaching the real terminal.
 */

import { buildOsc52, wrapForMultiplexer } from '../src/tui/osc52.ts'

let passed = 0
let failed = 0
function check(name: string, condition: boolean): void {
  if (condition) {
    passed += 1
  } else {
    failed += 1
    console.error(`FAIL: ${name}`)
  }
}

const ESC = ''

// -------------------------------------------------------------- buildOsc52

const short = buildOsc52('hello')
check('the sequence opens with OSC 52 set-clipboard', short.sequence.startsWith(`${ESC}]52;c;`))
check('the sequence closes with ST', short.sequence.endsWith(`${ESC}\\`))
check('a short payload is not truncated', short.truncated === false)
check('the payload is the base64 of the given text', short.sequence.includes(Buffer.from('hello', 'utf8').toString('base64')))

const long = buildOsc52('x'.repeat(1000), 40)
check('a payload over the cap is truncated', long.truncated === true)
const base64Part = long.sequence.slice(`${ESC}]52;c;`.length, -2)
check('the truncated payload still decodes as valid base64', base64Part.length % 4 === 0)
check('the truncated payload is capped, not merely shortened arbitrarily', base64Part.length === 40)

const empty = buildOsc52('')
check('an empty string still builds a well-formed sequence', empty.sequence === `${ESC}]52;c;${ESC}\\`)
check('an empty string is never truncated', empty.truncated === false)

// -------------------------------------------------------- wrapForMultiplexer

const sequence = buildOsc52('clip me').sequence

check('with no multiplexer, the sequence passes through unchanged', wrapForMultiplexer(sequence, {}) === sequence)

const tmuxWrapped = wrapForMultiplexer(sequence, { TMUX: '/home/tester/tmux/default,1234,0' })
check('inside tmux, the sequence is wrapped in a Ptmux DCS', tmuxWrapped.startsWith(`${ESC}Ptmux;`))
check('the tmux wrapper closes with ST', tmuxWrapped.endsWith(`${ESC}\\`))
check(
  'every embedded ESC is doubled so tmux\'s own parser does not end the passthrough early',
  tmuxWrapped.includes(`${ESC}${ESC}]52`),
)
// The doubled-ESC payload, once un-doubled, is exactly the original sequence.
const innerPayload = tmuxWrapped.slice(`${ESC}Ptmux;`.length, -2)
check(
  'un-doubling the wrapped payload recovers the original sequence exactly',
  innerPayload.replaceAll(ESC + ESC, ESC) === sequence,
)

const screenWrapped = wrapForMultiplexer(sequence, { STY: '12345.pts-0.host' })
check('inside screen (STY set), the sequence is wrapped in a bare DCS', screenWrapped.startsWith(`${ESC}P`))
check('the screen wrapper closes with ST', screenWrapped.endsWith(`${ESC}\\`))
check(
  'a short payload under screen fits in one DCS chunk',
  screenWrapped === `${ESC}P${sequence}${ESC}\\`,
)

const screenByTerm = wrapForMultiplexer(sequence, { TERM: 'screen-256color' })
check('a TERM starting with "screen" is recognized even without STY', screenByTerm.startsWith(`${ESC}P`))

const longSequence = buildOsc52('y'.repeat(3000)).sequence
const chunked = wrapForMultiplexer(longSequence, { STY: '1.pts-0.host' })
const dcsOpens = chunked.split(`${ESC}P`).length - 1
check('a payload past screen\'s 768-byte DCS limit is split into multiple chunks', dcsOpens > 1)
// Rather than parse the wrapped output back apart — ambiguous in general,
// since the sequence's own embedded ST can land inside a chunk's payload and
// read exactly like a synthetic chunk boundary — build the expected output
// the same way the function itself does, from the one chunk size it uses,
// and compare directly.
const SCREEN_DCS_LIMIT = 768
let expected = ''
for (let i = 0; i < longSequence.length; i += SCREEN_DCS_LIMIT) {
  expected += `${ESC}P${longSequence.slice(i, i + SCREEN_DCS_LIMIT)}${ESC}\\`
}
check('the chunked output matches fixed-size slices of the original, each independently wrapped', chunked === expected)

// TMUX takes precedence if, somehow, both are set at once.
const both = wrapForMultiplexer(sequence, { TMUX: 'x', STY: 'y' })
check('TMUX is checked before screen when both env vars are present', both.startsWith(`${ESC}Ptmux;`))

if (failed > 0) {
  console.error(`${String(failed)} osc52 checks failed`)
  process.exit(1)
}
console.log(`ok - ${String(passed)} osc52 checks passed`)
