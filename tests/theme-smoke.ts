/**
 * Palette smoke: the theme table and the switch that installs it.
 *
 * Dependency-free like the other suites — it imports `src/tui/theme.ts` and
 * `src/tui/themes.ts` directly and asserts on the bytes `style()` emits,
 * because the bytes are the only thing the terminal actually sees.
 *
 * The NO_COLOR section runs in a child process: whether color is emitted at
 * all is read from the environment once, when the module is evaluated, so it
 * cannot be flipped from inside a run that has already imported the module.
 * This file re-executes itself with the variable set instead. The main path
 * forces color on (`./force-color.ts`) so the suite does not depend on the
 * shell it was started from.
 *
 * Run with: node --experimental-strip-types tests/theme-smoke.ts
 */

// Must come before the theme import: theme.ts reads the environment once, at
// evaluation time, and this suite asserts on the SGR bytes it emits.
import './force-color.ts'

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  RESET,
  activeTheme,
  applyTheme,
  colAccent,
  colBorder,
  colGold,
  colGreen,
  colInvert,
  colMuted,
  colOK,
  colRose,
  colText,
  colWarn,
  contrastRatio,
  listThemes,
  readableOn,
  refreshTheme,
  resolve,
  style,
  type AdaptiveColor,
} from '../src/tui/theme.ts'
import { DEFAULT_THEME, THEMES, findTheme } from '../src/tui/themes.ts'

/** The ten constants, paired with the table slot each one mirrors. */
const SLOTS: [string, AdaptiveColor, keyof (typeof THEMES)[number]['colors']][] = [
  ['colAccent', colAccent, 'accent'],
  ['colMuted', colMuted, 'muted'],
  ['colBorder', colBorder, 'border'],
  ['colText', colText, 'text'],
  ['colWarn', colWarn, 'warn'],
  ['colOK', colOK, 'ok'],
  ['colGreen', colGreen, 'green'],
  ['colGold', colGold, 'gold'],
  ['colRose', colRose, 'rose'],
  ['colInvert', colInvert, 'invert'],
]

/**
 * A sample that exercises every constant at once, so one comparison covers
 * the whole palette rather than ten.
 */
function fingerprint(): string {
  return SLOTS.map(([, color]) => style('sample', { fg: color, bold: true })).join('|')
}

/** The NO_COLOR half, run in a child with the variable set. */
function noColorChecks(): void {
  assert.equal(style('x', { fg: colAccent }), 'x', 'NO_COLOR suppresses a foreground')
  assert.equal(style('x', { bg: colInvert }), 'x', 'NO_COLOR suppresses a background')
  assert.equal(
    style('x', { fg: colAccent, bg: colInvert }),
    'x',
    'NO_COLOR suppresses both at once',
  )
  assert.ok(applyTheme('gruvbox'), 'a theme still installs under NO_COLOR')
  assert.equal(style('x', { fg: colAccent }), 'x', 'switching theme emits nothing under NO_COLOR')
  assert.ok(
    style('x', { bold: true }).includes(`${''}[1m`),
    'NO_COLOR leaves text attributes alone',
  )
}

if (process.env['MOQI_THEME_SMOKE_NO_COLOR'] === '1') {
  // The child says nothing on success; the parent scores it as one check.
  noColorChecks()
  process.exit(0)
}

let checks = 0
function check(label: string, condition: boolean): void {
  assert.ok(condition, label)
  checks += 1
}

// ------------------------------------------------------------- the table

const HEX = /^#[0-9A-Fa-f]{6}$/

check('the table is not empty', THEMES.length >= 4)
check(
  'every theme has a lowercase hyphenated name',
  THEMES.every((theme) => /^[a-z][a-z0-9-]*$/.test(theme.name)),
)
check(
  'theme names are unique',
  new Set(THEMES.map((theme) => theme.name)).size === THEMES.length,
)
check('every theme carries a description', THEMES.every((theme) => theme.description !== ''))
check('the default theme is in the table', findTheme(DEFAULT_THEME) !== undefined)
check('listThemes() exposes the same table', listThemes().length === THEMES.length)
check('findTheme ignores case and surrounding space', findTheme('  GRUVBOX ')?.name === 'gruvbox')

for (const theme of THEMES) {
  for (const [, , slot] of SLOTS) {
    const color = theme.colors[slot]
    check(`${theme.name}.${slot} defines a light variant`, typeof color.light === 'string')
    check(`${theme.name}.${slot} defines a dark variant`, typeof color.dark === 'string')
    check(`${theme.name}.${slot}.light is #rrggbb`, HEX.test(color.light))
    check(`${theme.name}.${slot}.dark is #rrggbb`, HEX.test(color.dark))
  }
}

// ------------------------------------------------------- installing a theme

check('the app starts on the default theme', activeTheme() === DEFAULT_THEME)

// What an importing module holds: the object itself, captured once, exactly
// as `view.ts` and friends capture it when they are first evaluated.
const captured = colAccent

const original = fingerprint()
check('the default palette emits truecolor', original.includes('38;2;'))
check('a styled sample is closed again', original.includes(RESET))

const seen = new Map<string, string>([[DEFAULT_THEME, original]])
for (const theme of THEMES) {
  if (theme.name === DEFAULT_THEME) continue
  check(`applyTheme('${theme.name}') reports success`, applyTheme(theme.name))
  check(`activeTheme() follows the switch to ${theme.name}`, activeTheme() === theme.name)
  const emitted = fingerprint()
  check(`${theme.name} changes what style() emits`, emitted !== original)
  for (const [name, previous] of seen) {
    check(`${theme.name} is distinct from ${name}`, emitted !== previous)
  }
  seen.set(theme.name, emitted)
}

// The whole design rests on this: a reference captured before the switch sees
// the new palette, because applyTheme writes through the object rather than
// replacing it. If this fails, every importing module keeps the old colors.
check('a reference captured before the switch is still colAccent', captured === colAccent)
check(
  'a reference captured before the switch sees the new palette',
  captured.dark === findTheme(activeTheme())?.colors.accent.dark,
)
check(
  'the installed palette matches the table entry',
  SLOTS.every(([, color, slot]) => {
    const theme = findTheme(activeTheme())
    return (
      color.light === theme?.colors[slot].light && color.dark === theme?.colors[slot].dark
    )
  }),
)

// ------------------------------------------------------ back to the default

check(`applyTheme('${DEFAULT_THEME}') reports success`, applyTheme(DEFAULT_THEME))
check('the default restores the original bytes exactly', fingerprint() === original)
check('activeTheme() is the default again', activeTheme() === DEFAULT_THEME)

// ------------------------------------------------------------ bad input

const before = fingerprint()
check('an unknown name is rejected', applyTheme('no-such-theme') === false)
check('an empty name is rejected', applyTheme('') === false)
check('a near miss is rejected rather than guessed', applyTheme('rose pine') === false)
check('a rejected switch leaves the palette untouched', fingerprint() === before)
check('a rejected switch leaves the active name untouched', activeTheme() === DEFAULT_THEME)

// --------------------------------------------------- light and dark variants

// Both halves of a palette have to be reachable, or half the table is dead
// weight. MOQI_THEME picks the variant and is orthogonal to the choice of
// palette, so the same theme must emit different bytes on each background.
const savedVariant = process.env['MOQI_THEME']
try {
  applyTheme('nord')
  process.env['MOQI_THEME'] = 'dark'
  refreshTheme()
  const darkBytes = fingerprint()
  process.env['MOQI_THEME'] = 'light'
  refreshTheme()
  const lightBytes = fingerprint()
  check('the light variant differs from the dark one', darkBytes !== lightBytes)
  check(
    'the variant is orthogonal to the palette',
    darkBytes.includes('38;2;136;192;208') && lightBytes.includes('38;2;94;129;172'),
  )
} finally {
  if (savedVariant === undefined) delete process.env['MOQI_THEME']
  else process.env['MOQI_THEME'] = savedVariant
  refreshTheme()
  applyTheme(DEFAULT_THEME)
}

// ---------------------------------------------------------------- NO_COLOR

const childEnv = { ...process.env }
delete childEnv['FORCE_COLOR']
// ------------------------------------------------- text on a colored bar

// A diff bar fills its row with the change's color, so its text has to be
// chosen against that bar rather than assumed: the better of the palette's two
// text colors, measured. The wrong guess is invisible on one terminal and
// unreadable on the other.
for (const bar of [colRose, colGreen]) {
  const chosen = readableOn(bar).fg
  const other = chosen === colText ? colInvert : colText
  check(
    `the bar text is the better-contrasting palette color (${resolve(bar)})`,
    chosen !== undefined && contrastRatio(bar, chosen) >= contrastRatio(bar, other),
  )
  check(
    `the bar text clears the large-text contrast floor (${resolve(bar)})`,
    chosen !== undefined && contrastRatio(bar, chosen) >= 3,
  )
}

// The measured choice tracks the terminal: the same palette needs a different
// text color on its light bar and its dark one.
const darkChoice = readableOn(colRose).fg
process.env['MOQI_THEME'] = 'light'
refreshTheme()
const lightChoice = readableOn(colRose).fg
check('a bar text follows the terminal background', darkChoice !== lightChoice)
delete process.env['MOQI_THEME']
refreshTheme()

delete childEnv['MOQI_THEME']

execFileSync(process.execPath, ['--experimental-strip-types', fileURLToPath(import.meta.url)], {
  // FORCE_COLOR would make Node warn that it is overriding NO_COLOR; the app
  // reads the variables itself, but the warning would be noise in the run.
  env: { ...childEnv, NO_COLOR: '1', MOQI_THEME_SMOKE_NO_COLOR: '1' },
  stdio: ['ignore', 'ignore', 'inherit'],
})
checks += 1

// eslint-disable-next-line no-console
console.log(`ok - ${String(checks)} checks passed`)
