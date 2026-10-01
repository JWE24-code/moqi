/**
 * Smoke tests for the interface-language catalog: key parity, fallbacks, and
 * that the key reference keeps its shape in every language (the overlay shows
 * its tail, so a shorter translation would hide the quit keys).
 */
import assert from 'node:assert/strict'
import {
  LANGS,
  currentLanguage,
  fill,
  helpText,
  isLang,
  setLanguage,
  t,
  translate,
} from '../src/tui/i18n.ts'
import { render, HELP_TEXT } from '../src/tui/view.ts'
import { Composer, Palette, Picker } from '../src/tui/state.ts'
import type { Snapshot } from '../src/tui/view.ts'

let checks = 0
function check(label: string, condition: boolean): void {
  assert.ok(condition, label)
  checks += 1
}

// ------------------------------------------------------------- languages

check('two languages ship', LANGS.length === 2)
check('every language has a label', LANGS.every((lang) => lang.label !== ''))
check('an id names a language', isLang('zh-CN') && isLang('en'))
check('an unknown id is not a language', !isLang('fr'))
check('the empty string is not a language', !isLang(''))
check('default is english', currentLanguage() === 'en')

// ---------------------------------------------------------------- lookup

check('a known key translates', translate('en', 'approval.allow') === 'Allow once')
check('the other language translates it too', translate('zh-CN', 'approval.allow') === '允许一次')
check('an unknown key falls back to the key itself', translate('en', 'nope.missing') === 'nope.missing')
check('an unknown language falls back to english', translate('fr' as 'en', 'approval.deny') === 'Deny')
check('placeholders are filled', translate('en', 'approval.title', { tool: 'shell' }) === 'Allow shell?')
check('a placeholder without a value survives', fill('a {x} b', {}) === 'a {x} b')
check('filling nothing changes nothing', fill('plain', undefined) === 'plain')

// Switching the active language is what `t` reads.
setLanguage('zh-CN')
check('t follows the active language', t('approval.allow') === '允许一次')
check('help follows the active language', helpText().includes('按键'))
setLanguage('en')
check('switching back restores english', t('approval.allow') === 'Allow once')

// ------------------------------------------------------- catalog parity

const EN_KEYS = new Set(['welcome.title', 'welcome.connected', 'approval.hint', 'help.body'])
const ZH_KEYS = [...EN_KEYS]
check('every sampled key exists in both languages', ZH_KEYS.every((key) => translate('zh-CN', key) !== key))

// Full parity, not samples: a translation that lags a new English string is
// invisible at runtime because the fallback silently renders English, so only
// comparing the whole key sets catches it.
import { catalogKeys } from '../src/tui/i18n.ts'
const en = new Set(catalogKeys('en'))
const zh = new Set(catalogKeys('zh-CN'))
check('every english key has a translation', [...en].every((key) => zh.has(key)))
check('no translation exists without an english key', [...zh].every((key) => en.has(key)))
check('no translation is empty', [...zh].every((key) => translate('zh-CN', key).trim() !== ''))

// A translation may drop a placeholder its language has no use for (english
// plural `{s}`, which chinese cannot express) but must never rename one or
// invent one the caller does not fill -- that would render as literal `{x}`.
const placeholders = (text: string): Set<string> => new Set(text.match(/\{(\w+)\}/g) ?? [])
check(
  'every translated placeholder is one the english string defines',
  [...zh].every((key) => {
    const used = placeholders(translate('zh-CN', key))
    const known = placeholders(translate('en', key))
    return [...used].every((name) => known.has(name))
  }),
)

const enLines = translate('en', 'help.body').split('\n')
const zhLines = translate('zh-CN', 'help.body').split('\n')
check('the key reference has the same number of lines in both languages', enLines.length === zhLines.length)
check('the title lines line up', enLines[0] === '**Keys**' && zhLines[0] === '**按键**')
check(
  'both languages end with the quit key',
  (enLines.at(-1) ?? '').includes('ctrl+c') &&
    (zhLines.at(-1) ?? '').includes('ctrl+c'),
)
check(
  'both languages document the newly added surfaces',
  enLines.some((line) => line.includes('/rewind')) && zhLines.some((line) => line.includes('/rewind')),
)
check('the english reference matches the export', HELP_TEXT === translate('en', 'help.body'))

// ------------------------------------------------------- rendered chrome

function frame(over: Partial<Snapshot>): string[] {
  const snapshot: Snapshot = {
    columns: 90,
    rows: 24,
    title: 't',
    host: 'local harness',
    modelName: 'deepseek-chat',
    messages: [],
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
    expandTools: true,
    sessions: [],
    background: [],
    expandBackground: false,
    elapsedSeconds: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    haveUsage: false,
    contextLimit: 0,
    confirming: false,
    ...over,
  }
  return render(snapshot).lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ''))
}

setLanguage('en')
check('the english welcome renders', frame({}).some((line) => line.includes('type a message')))
check('the english footer hint renders', frame({}).some((line) => line.includes('/ commands')))
setLanguage('zh-CN')
check('the chinese welcome renders', frame({}).some((line) => line.includes('输入消息')))
check('the chinese footer hint renders', frame({}).some((line) => line.includes('/ 命令')))
setLanguage('en')

console.log(`ok - ${String(checks)} i18n checks passed`)
