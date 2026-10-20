/**
 * Pins the footer's left half (`footerLeft` in `src/tui/view.ts`) at every
 * branch: mode badge (warning and plain), branch, memory off, the context
 * percentage at and below the warning line, usage arrows, tokens per second,
 * the cache-hit rate (and when it is left out), the estimate when there is no
 * usage yet, and the streaming spinner. Each case compares the whole footer
 * row, SGR included, so a refactor that reorders or recolors a segment fails.
 *
 * Run with: node --experimental-strip-types tests/footer-smoke.ts
 * Regenerate the expected rows (only for an intended change) with
 * MOQI_FOOTER_PRINT=1.
 */

import './force-color.ts'
import assert from 'node:assert/strict'

import { Composer, Palette, Picker, textMessage } from '../src/tui/state.ts'
import { render, type Snapshot } from '../src/tui/view.ts'

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const base: Snapshot = {
    columns: 160,
    rows: 20,
    title: 'a session',
    host: 'local harness',
    modelName: 'deepseek-chat',
    messages: [textMessage('user', 'hello there')],
    streamingSegments: [],
    streamingReasoning: '',
    streaming: false,
    spinner: '⠋',
    status: '',
    statusIsError: false,
    overlay: '',
    showThinking: false,
    composer: new Composer(),
    palette: new Palette(),
    picker: new Picker(),
    scrollBack: 0,
    expandTools: false,
    sessions: [],
    background: [],
    expandBackground: false,
    elapsedSeconds: 0,
    promptTokens: 1200,
    completionTokens: 312,
    totalTokens: 1512,
    haveUsage: true,
    contextLimit: 65536,
    confirming: false,
  }
  return { ...base, ...overrides }
}

const cases: Record<string, Partial<Snapshot>> = {
  plain: {},
  noUsage: { haveUsage: false },
  noLimit: { contextLimit: 0 },
  warnBadge: { modeBadge: '⚠ yolo' },
  plainBadge: { modeBadge: 'plan' },
  branch: { branch: 'moqi/feature' },
  memoryOff: { memoryOff: true },
  memoryOn: { memoryOff: false },
  nearlyFull: { totalTokens: 60000 },
  atEighty: { totalTokens: 52429, contextLimit: 65536 },
  tps: { tps: 42.6 },
  zeroTps: { tps: 0 },
  cache: { cacheReadTokens: 900 },
  cacheOverflow: { cacheReadTokens: 5000 },
  cacheNoPrompt: { cacheReadTokens: 900, promptTokens: 0 },
  cacheNoUsage: { cacheReadTokens: 900, tps: 30, haveUsage: false },
  streaming: { streaming: true, spinner: '⠙' },
  everything: {
    modeBadge: '⚠ yolo',
    branch: 'moqi/x',
    memoryOff: true,
    totalTokens: 64000,
    tps: 12,
    cacheReadTokens: 600,
    streaming: true,
  },
}

function footer(overrides: Partial<Snapshot>): string {
  return render(snapshot(overrides)).lines.at(-1) ?? ''
}

const expected: Record<string, string> = {
  "plain": " \u001b[38;2;92;99;112mdeepseek-chat\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112mctx 1.5K/65K 2%\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112m↑1.2K ↓312\u001b[0m                                                                         \u001b[38;2;92;99;112m/ commands  ·  ? help  ·  ctrl+c quit\u001b[0m",
  "noUsage": " \u001b[38;2;92;99;112mdeepseek-chat\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112mctx ~3/65K 0%\u001b[0m                                                                                          \u001b[38;2;92;99;112m/ commands  ·  ? help  ·  ctrl+c quit\u001b[0m",
  "noLimit": " \u001b[38;2;92;99;112mdeepseek-chat\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112mctx 1.5K/0 0%\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112m↑1.2K ↓312\u001b[0m                                                                           \u001b[38;2;92;99;112m/ commands  ·  ? help  ·  ctrl+c quit\u001b[0m",
  "warnBadge": " \u001b[38;2;224;108;90m⚠ yolo\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112mdeepseek-chat\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112mctx 1.5K/65K 2%\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112m↑1.2K ↓312\u001b[0m                                                              \u001b[38;2;92;99;112m/ commands  ·  ? help  ·  ctrl+c quit\u001b[0m",
  "plainBadge": " \u001b[38;2;130;162;184mplan\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112mdeepseek-chat\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112mctx 1.5K/65K 2%\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112m↑1.2K ↓312\u001b[0m                                                                \u001b[38;2;92;99;112m/ commands  ·  ? help  ·  ctrl+c quit\u001b[0m",
  "branch": " \u001b[38;2;92;99;112mdeepseek-chat\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112m⎇ moqi/feature\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112mctx 1.5K/65K 2%\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112m↑1.2K ↓312\u001b[0m                                                      \u001b[38;2;92;99;112m/ commands  ·  ? help  ·  ctrl+c quit\u001b[0m",
  "memoryOff": " \u001b[38;2;92;99;112mdeepseek-chat\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;130;162;184mmemory off\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112mctx 1.5K/65K 2%\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112m↑1.2K ↓312\u001b[0m                                                          \u001b[38;2;92;99;112m/ commands  ·  ? help  ·  ctrl+c quit\u001b[0m",
  "memoryOn": " \u001b[38;2;92;99;112mdeepseek-chat\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112mctx 1.5K/65K 2%\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112m↑1.2K ↓312\u001b[0m                                                                         \u001b[38;2;92;99;112m/ commands  ·  ? help  ·  ctrl+c quit\u001b[0m",
  "nearlyFull": " \u001b[38;2;92;99;112mdeepseek-chat\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;224;108;90mctx 60K/65K 91%\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112m↑1.2K ↓312\u001b[0m                                                                         \u001b[38;2;92;99;112m/ commands  ·  ? help  ·  ctrl+c quit\u001b[0m",
  "atEighty": " \u001b[38;2;92;99;112mdeepseek-chat\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;224;108;90mctx 52K/65K 80%\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112m↑1.2K ↓312\u001b[0m                                                                         \u001b[38;2;92;99;112m/ commands  ·  ? help  ·  ctrl+c quit\u001b[0m",
  "tps": " \u001b[38;2;92;99;112mdeepseek-chat\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112mctx 1.5K/65K 2%\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112m↑1.2K ↓312\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112m43 tok/s\u001b[0m                                                            \u001b[38;2;92;99;112m/ commands  ·  ? help  ·  ctrl+c quit\u001b[0m",
  "zeroTps": " \u001b[38;2;92;99;112mdeepseek-chat\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112mctx 1.5K/65K 2%\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112m↑1.2K ↓312\u001b[0m                                                                         \u001b[38;2;92;99;112m/ commands  ·  ? help  ·  ctrl+c quit\u001b[0m",
  "cache": " \u001b[38;2;92;99;112mdeepseek-chat\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112mctx 1.5K/65K 2%\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112m↑1.2K ↓312\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112mcache 75%\u001b[0m                                                           \u001b[38;2;92;99;112m/ commands  ·  ? help  ·  ctrl+c quit\u001b[0m",
  "cacheOverflow": " \u001b[38;2;92;99;112mdeepseek-chat\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112mctx 1.5K/65K 2%\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112m↑1.2K ↓312\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112mcache 100%\u001b[0m                                                          \u001b[38;2;92;99;112m/ commands  ·  ? help  ·  ctrl+c quit\u001b[0m",
  "cacheNoPrompt": " \u001b[38;2;92;99;112mdeepseek-chat\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112mctx 1.5K/65K 2%\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112m↑0 ↓312\u001b[0m                                                                            \u001b[38;2;92;99;112m/ commands  ·  ? help  ·  ctrl+c quit\u001b[0m",
  "cacheNoUsage": " \u001b[38;2;92;99;112mdeepseek-chat\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112mctx ~3/65K 0%\u001b[0m                                                                                          \u001b[38;2;92;99;112m/ commands  ·  ? help  ·  ctrl+c quit\u001b[0m",
  "streaming": " \u001b[38;2;130;162;184m⠙\u001b[0m \u001b[38;2;92;99;112mdeepseek-chat\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112mctx 1.5K/65K 2%\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112m↑1.2K ↓312\u001b[0m                                                                       \u001b[38;2;92;99;112m/ commands  ·  ? help  ·  ctrl+c quit\u001b[0m",
  "everything": " \u001b[38;2;130;162;184m⠋\u001b[0m \u001b[38;2;224;108;90m⚠ yolo\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112mdeepseek-chat\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112m⎇ moqi/x\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;130;162;184mmemory off\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;224;108;90mctx 64K/65K 97%\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112m↑1.2K ↓312\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112m12 tok/s\u001b[0m\u001b[38;2;92;99;112m  ·  \u001b[0m\u001b[38;2;92;99;112mcache 50%\u001b[0m     \u001b[38;2;92;99;112m/ commands  ·  ? help  ·  ctrl+c quit\u001b[0m"
}

if (process.env['MOQI_FOOTER_PRINT'] === '1') {
  const out: Record<string, string> = {}
  for (const [name, overrides] of Object.entries(cases)) out[name] = footer(overrides)
  console.log(JSON.stringify(out, null, 2))
  process.exit(0)
}

let checks = 0
for (const [name, overrides] of Object.entries(cases)) {
  assert.equal(footer(overrides), expected[name], `footer: ${name}`)
  checks += 1
}
console.log(`footer-smoke: ${String(checks)} checks passed`)
