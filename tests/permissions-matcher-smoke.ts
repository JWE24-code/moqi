/**
 * Permissions matcher smoke: pins the exact behavior of the command lexer,
 * the rules-file scalar and line parsers, pattern quoting, and the store's
 * write path, branch by branch, so their refactors cannot drift.
 *
 * The lexer is private; it is reached through `matches` (does an exact
 * pattern cover this command, segment by segment?) and `suggestPattern`.
 * The store runs against a mkdtemp `DSH_HOME`, removed however the run ends.
 *
 * Run with: node --experimental-strip-types tests/permissions-matcher-smoke.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'moqi-permissions-matcher-'))
process.env['DSH_HOME'] = home

const { addRule, loadAllRules, matches, normalizeRule, parseRules, permissionsDir, rulesPath, suggestPattern } =
  await import('../src/permissions.ts')
type Rule = import('../src/permissions.ts').Rule

let checks = 0
function check(name: string, condition: boolean): void {
  checks += 1
  assert.ok(condition, name)
}

/** The error message an action throws, or undefined when it does not throw. */
function thrown(action: () => unknown): string | undefined {
  try {
    action()
    return undefined
  } catch (error) {
    return (error as Error).message
  }
}

type Tool = 'bash' | 'pwsh'

/** One backslash, for literals String.raw cannot hold (a trailing `\`, or beside a control char). */
const BACKSLASH = String.fromCodePoint(0x5c)

/** Whether the lexer accepts the command at all (a lone `*` covers any segment). */
function accepted(tool: Tool, command: string): boolean {
  return matches([{ tool, command: '*' }], tool, command) !== undefined
}

/**
 * Whether the command lexes to these segments: every segment hits one of the
 * given patterns (bash-quoted words, compared exactly), and the command is a
 * single segment exactly when one pattern is given (a compound command gets
 * no suggestion; a single one always does).
 */
function lexesTo(tool: Tool, command: string, ...patterns: string[]): boolean {
  const rules: Rule[] = patterns.map((p) => ({ tool, command: p }))
  if (matches(rules, tool, command) === undefined) return false
  const single = suggestPattern(tool, command) !== undefined
  return single === (patterns.length === 1)
}

try {
  // ------------------------------------------------------- control chars

  check('C0 control refused', !accepted('bash', 'ls\x01'))
  check('DEL refused', !accepted('bash', 'ls\x7f'))
  check('ESC refused', !accepted('bash', 'echo \x1b[2J'))
  check('control inside single quotes refused', !accepted('bash', "echo 'a\x01'"))
  check('control inside double quotes refused', !accepted('bash', 'echo "a\x01"'))
  check('tab separates words', lexesTo('bash', 'ls\t-l', 'ls -l'))
  check('carriage return refused', !accepted('bash', 'ls\r'))
  check('non-ASCII accepted', lexesTo('bash', 'echo héllo', 'echo héllo'))
  check('astral char accepted', lexesTo('bash', 'echo 😀', "echo '😀'"))
  // Pre-existing quirk, pinned not endorsed: an escaped control char in
  // bash's normal state is consumed with the backslash and never checked.
  check('escaped control char is consumed unchecked (bash)', accepted('bash', `echo a${BACKSLASH}\x01`))
  check('escaped control char in pwsh is checked', !accepted('pwsh', `echo a${BACKSLASH}\x01`))

  // -------------------------------------------------------- single quotes

  check('single-quoted word', lexesTo('bash', "echo 'a b'", "echo 'a b'"))
  check('backslash literal in single quotes', lexesTo('bash', String.raw`echo 'a\b'`, String.raw`echo 'a\b'`))
  check('substitution literal in single quotes', lexesTo('bash', "echo '$(id)'", "echo '$(id)'"))
  check('operators literal in single quotes', lexesTo('bash', "echo 'a;b|c&d>e<f'", "echo 'a;b|c&d>e<f'"))
  check('unterminated single quote refused', !accepted('bash', "echo 'a"))
  check('empty single quotes are a word', lexesTo('bash', "echo ''", "echo ''"))
  check('empty single quotes differ from nothing', matches([{ tool: 'bash', command: 'echo' }], 'bash', "echo ''") === undefined)
  check('adjacent quoting joins one word', lexesTo('bash', "echo a'b'\"c\"", 'echo abc'))
  check('quoted star is not a wildcard', lexesTo('bash', "ls '*'", "ls '*'"))
  check('quoted star does not match a plain star rule', matches([{ tool: 'bash', command: "ls '*'" }], 'bash', 'ls x') === undefined)

  // -------------------------------------------------------- double quotes

  check('double-quoted word', lexesTo('bash', 'echo "a b"', "echo 'a b'"))
  check('unterminated double quote refused', !accepted('bash', 'echo "a'))
  check('backtick in double quotes refused', !accepted('bash', 'echo "`id`"'))
  check('$( in double quotes refused', !accepted('bash', 'echo "$(id)"'))
  check('${ in double quotes refused', !accepted('bash', 'echo "${x}"'))
  check('plain $var in double quotes kept literal', lexesTo('bash', 'echo "$x"', "echo '$x'"))
  check('trailing $ in double quotes kept', lexesTo('bash', 'echo "a$"', "echo 'a$'"))
  check(String.raw`bash: \$ in double quotes`, lexesTo('bash', String.raw`echo "a\$b"`, "echo 'a$b'"))
  check(`bash: ${BACKSLASH}\` in double quotes`, lexesTo('bash', `echo "a${BACKSLASH}\`b"`, "echo 'a`b'"))
  check(String.raw`bash: \" in double quotes`, lexesTo('bash', String.raw`echo "a\"b"`, "echo 'a\"b'"))
  check(String.raw`bash: \\ in double quotes`, lexesTo('bash', String.raw`echo "a\\b"`, String.raw`echo 'a\b'`))
  check(String.raw`bash: \n (letter) keeps the backslash`, lexesTo('bash', String.raw`echo "a\nb"`, String.raw`echo 'a\nb'`))
  check('bash: line continuation in double quotes', lexesTo('bash', `echo "a${BACKSLASH}\nb"`, 'echo ab'))
  check('bash: backslash at end inside double quotes refused', !accepted('bash', `echo "a${BACKSLASH}`))
  check('bash: escaped closing quote leaves it open', !accepted('bash', String.raw`echo "a\"`))
  check('pwsh: backslash is plain in double quotes', lexesTo('pwsh', String.raw`echo "a\"`, String.raw`echo 'a\'`))
  check('pwsh: $( in double quotes refused', !accepted('pwsh', 'echo "$(id)"'))
  check('newline inside double quotes is literal', lexesTo('bash', 'echo "a\nb"', "echo 'a\nb'"))
  check('semicolon inside double quotes is literal', lexesTo('bash', 'echo "a;b"', "echo 'a;b'"))

  // ------------------------------------------------------- normal: split

  check('spaces collapse', lexesTo('bash', '  git   log  ', 'git log'))
  check('newline splits', lexesTo('bash', 'ls\npwd', 'ls', 'pwd'))
  check('semicolon splits', lexesTo('bash', 'ls;pwd', 'ls', 'pwd'))
  check('&& splits', lexesTo('bash', 'ls && pwd', 'ls', 'pwd'))
  check('& splits', lexesTo('bash', 'ls & pwd', 'ls', 'pwd'))
  check('|| splits', lexesTo('bash', 'ls || pwd', 'ls', 'pwd'))
  check('| splits', lexesTo('bash', 'ls|pwd', 'ls', 'pwd'))
  check('trailing ; dropped', lexesTo('bash', 'ls;', 'ls'))
  check('trailing & dropped', lexesTo('bash', 'ls &', 'ls'))
  check('leading ;; dropped', lexesTo('bash', ';;ls', 'ls'))
  check('empty command lexes to nothing', !accepted('bash', ''))
  check('only separators lex to nothing', !accepted('bash', ' ; ; '))
  check('second segment must match too', matches([{ tool: 'bash', command: 'ls' }], 'bash', 'ls; rm x') === undefined)
  check('&&& is && then &', lexesTo('bash', 'ls &&& pwd', 'ls', 'pwd'))
  check('||| is || then |', lexesTo('bash', 'ls ||| pwd', 'ls', 'pwd'))

  // ------------------------------------------------------- normal: refused

  for (const [name, cmd] of [
    ['<', 'cat < x'],
    ['heredoc', 'cat <<EOF'],
    ['(', '(ls)'],
    [')', 'ls )'],
    ['backtick', 'echo `id`'],
    ['$(', 'echo $(id)'],
    ['${', 'echo ${x}'],
  ] as const) {
    check(`bash refuses ${name}`, !accepted('bash', cmd))
    check(`pwsh refuses ${name}`, !accepted('pwsh', cmd))
  }
  check('plain $var accepted', lexesTo('bash', 'echo $x', "echo '$x'"))
  check('trailing $ accepted', lexesTo('bash', 'echo $', "echo '$'"))
  check('$ before space accepted', lexesTo('bash', 'echo $ x', "echo '$' x"))

  // ------------------------------------------------------- redirects: >

  check('> /dev/null dropped', lexesTo('bash', 'ls > /dev/null', 'ls'))
  check('>/dev/null dropped', lexesTo('bash', 'ls >/dev/null', 'ls'))
  check('>> /dev/null dropped', lexesTo('bash', 'ls >> /dev/null', 'ls'))
  check('2>/dev/null dropped with its fd', lexesTo('bash', 'ls 2>/dev/null', 'ls'))
  check('2>&1 dropped', lexesTo('bash', 'ls 2>&1', 'ls'))
  check('>&2 dropped', lexesTo('bash', 'echo x >&2', 'echo x'))
  check('multi-digit fd accepted', lexesTo('bash', 'ls 10>/dev/null', 'ls'))
  check('redirect then more words', lexesTo('bash', 'ls >/dev/null -l', 'ls -l'))
  check('redirect before ; splits', lexesTo('bash', 'ls >/dev/null;pwd', 'ls', 'pwd'))
  check('redirect before | splits', lexesTo('bash', 'ls >/dev/null|pwd', 'ls', 'pwd'))
  check('redirect before & splits', lexesTo('bash', 'ls >/dev/null&pwd', 'ls', 'pwd'))
  check('redirect before newline splits', lexesTo('bash', 'ls >/dev/null\npwd', 'ls', 'pwd'))
  check('redirect with tab before target', lexesTo('bash', 'ls >\t/dev/null', 'ls'))
  check('> to a file refused', !accepted('bash', 'ls > out'))
  check('>/dev/null2 refused', !accepted('bash', 'ls >/dev/null2'))
  check('>/dev/null/x refused', !accepted('bash', 'ls >/dev/null/x'))
  check('a word glued to > refused', !accepted('bash', 'ls a>/dev/null'))
  check('a quoted fd refused', !accepted('bash', "ls '2'>/dev/null"))
  check('>&x refused', !accepted('bash', 'ls >&x'))
  check('> $null refused in bash', !accepted('bash', 'ls > $null'))
  check('> $null accepted in pwsh', lexesTo('pwsh', 'ls > $null', 'ls'))
  check('2> $null accepted in pwsh', lexesTo('pwsh', 'ls 2> $null', 'ls'))
  check('> /dev/null accepted in pwsh', lexesTo('pwsh', 'ls > /dev/null', 'ls'))
  check('> file refused in pwsh', !accepted('pwsh', 'ls > out'))

  // ------------------------------------------------------ redirects: &>

  check('&> /dev/null dropped', lexesTo('bash', 'ls &> /dev/null', 'ls'))
  check('&>/dev/null dropped', lexesTo('bash', 'ls &>/dev/null', 'ls'))
  check('&>> /dev/null dropped', lexesTo('bash', 'ls &>> /dev/null', 'ls'))
  check('&> glued to a word refused', !accepted('bash', 'ls x&>/dev/null'))
  check('&> to a file refused', !accepted('bash', 'ls &> out'))
  check('&>&1 refused', !accepted('bash', 'ls &>&1'))
  check('&> $null accepted in pwsh', lexesTo('pwsh', 'ls &> $null', 'ls'))
  check('&> $null refused in bash', !accepted('bash', 'ls &> $null'))
  check('&>/dev/null then more', lexesTo('bash', 'ls &>/dev/null; pwd', 'ls', 'pwd'))

  // ----------------------------------------------- normal: backslash

  check('bash: escaped space joins a word', lexesTo('bash', String.raw`echo a\ b`, "echo 'a b'"))
  check('bash: escaped ; is literal', lexesTo('bash', String.raw`echo a\;b`, "echo 'a;b'"))
  check('bash: escaped $ then ( still refused', !accepted('bash', String.raw`echo \$(id`))
  check('bash: escaped $ before { is literal', lexesTo('bash', `echo ${BACKSLASH}\${`, "echo '${'"))
  check('bash: escaped $ before a word', lexesTo('bash', String.raw`echo \$x`, "echo '$x'"))
  check('bash: trailing backslash refused', !accepted('bash', `echo a${BACKSLASH}`))
  check('bash: line continuation', lexesTo('bash', `ls ${BACKSLASH}\n-l`, 'ls -l'))
  check('bash: line continuation mid-word', lexesTo('bash', `l${BACKSLASH}\ns`, 'ls'))
  check('bash: escaped star is not a wildcard', lexesTo('bash', String.raw`ls \*`, "ls '*'"))
  check('pwsh: backslash is plain', lexesTo('pwsh', String.raw`echo a\b`, String.raw`echo 'a\b'`))
  check('pwsh: trailing backslash plain', lexesTo('pwsh', `echo a${BACKSLASH}`, String.raw`echo 'a\'`))
  check('bash: escaped backslash', lexesTo('bash', String.raw`echo a\\b`, String.raw`echo 'a\b'`))
  check('bash: escaped > is literal, not a redirect', lexesTo('bash', String.raw`echo a\>b`, "echo 'a>b'"))
  check('bash: line continuation then fd redirect', lexesTo('bash', `ls 2${BACKSLASH}\n>/dev/null`, 'ls'))

  // ------------------------------------------------- wildcard patterns

  check('wildcard covers extra words', matches([{ tool: 'bash', command: 'git log *' }], 'bash', 'git log -1 x') !== undefined)
  check('wildcard covers none', matches([{ tool: 'bash', command: 'git log *' }], 'bash', 'git log') !== undefined)
  check('wildcard needs the prefix', matches([{ tool: 'bash', command: 'git log *' }], 'bash', 'git') === undefined)
  check('exact needs equal length', matches([{ tool: 'bash', command: 'git log' }], 'bash', 'git log -1') === undefined)
  check('a plain star word in a command matches literally', matches([{ tool: 'bash', command: "ls '*'" }], 'bash', 'ls *') !== undefined)

  // ---------------------------------------------- patterns: normalizeRule

  const norm = (command: string): string | undefined => normalizeRule({ tool: 'bash', command }).command
  check('pattern collapses spaces', norm('git  log   *') === 'git log *')
  check('safe word stays bare', norm('a-Z_0.9/:@%+=,~^') === 'a-Z_0.9/:@%+=,~^')
  check('a word with a space is single-quoted', norm("echo 'a b'") === "echo 'a b'")
  check('a single quote is escaped as close-escape-open', norm(`echo "it's"`) === String.raw`echo 'it'\''s'`)
  check('quoted pattern reparses to itself', norm(norm(`echo "it's"`)!) === String.raw`echo 'it'\''s'`)
  check('two quotes', norm(`echo "''"`) === String.raw`echo ''\'''\'''`)
  check('an empty word is quoted', norm("echo ''") === "echo ''")
  check('a dollar word is quoted', norm('echo $x') === "echo '$x'")
  check('a quoted star renders quoted', norm("ls '*'") === "ls '*'")
  check('a backslash word is quoted', norm(String.raw`echo 'a\b'`) === String.raw`echo 'a\b'`)
  check('star only allowed last', thrown(() => norm('ls * x'))?.includes('`*` is only allowed as the last word') === true)
  check('compound pattern refused', thrown(() => norm('ls; pwd'))?.includes('single command') === true)
  check('empty pattern refused', thrown(() => norm(''))?.includes('single command') === true)
  check('refused pattern explained', thrown(() => norm('ls $(x)'))?.includes('quoting or operators') === true)
  check('bare star pattern', norm('*') === '*')

  // ---------------------------------------------- tool names (S5869 class)

  const toolOk = (tool: string): boolean => thrown(() => normalizeRule({ tool })) === undefined
  check('plain tool ok', toolOk('read'))
  check('punctuated tool ok', toolOk('mcp__x.y-z'))
  check('non-ASCII tool ok', toolOk('lés'))
  check('empty tool refused', !toolOk(''))
  check('space refused', !toolOk('a b'))
  check('tab refused', !toolOk('a\tb'))
  check('newline refused', !toolOk('a\nb'))
  check('vertical tab refused', !toolOk('a\vb'))
  check('form feed refused', !toolOk('a\fb'))
  check('CR refused', !toolOk('a\rb'))
  check('NUL refused', !toolOk('a\x00b'))
  check('0x08 refused', !toolOk('a\x08b'))
  check('0x0e refused', !toolOk('a\x0eb'))
  check('0x1c refused', !toolOk('a\x1cb'))
  check('0x1f refused', !toolOk('a\x1fb'))
  check('DEL refused', !toolOk('a\x7fb'))
  check('NBSP refused', !toolOk('a\u00a0b'))
  check('ideographic space refused', !toolOk('a\u3000b'))
  check('line separator refused', !toolOk('a\u2028b'))
  check('BOM refused', !toolOk('a\ufeffb'))
  check('0x80 control accepted', toolOk('a\x80b'))
  check('tool message', thrown(() => normalizeRule({ tool: 'a b' })) === 'invalid tool name "a b"')

  // -------------------------------------------------- suggestPattern

  check('suggest: refused command', suggestPattern('bash', 'ls $(x)') === undefined)
  check('suggest: empty command', suggestPattern('bash', '') === undefined)
  check('suggest: compound command', suggestPattern('bash', 'ls; pwd') === undefined)
  check('suggest: one word', suggestPattern('bash', 'ls')?.command === 'ls *')
  check('suggest: pwsh dialect', suggestPattern('pwsh', String.raw`echo a\b`)?.command === String.raw`echo 'a\b' *`)

  // ------------------------------------------------- parseRules: scalars

  const one = (value: string): Rule[] => parseRules(`version: 1\nallow:\n  - tool: ${value}\n`)
  const tool1 = (value: string): string | undefined => {
    try {
      return one(value)[0]?.tool
    } catch (error) {
      return `!${(error as Error).message}`
    }
  }
  const err = (value: string): string | undefined => thrown(() => one(value))

  check('plain scalar', tool1('read') === 'read')
  check('plain scalar with comment', tool1('read # why') === 'read')
  check('plain scalar with tab-less multi-space comment', tool1('read    # why') === 'read')
  check('plain scalar: an inner # must be quoted', tool1('re#ad') === '!line 3: value "re#ad" must be quoted')
  check('plain scalar: first comment wins', tool1('read # a # b') === 'read')
  check('plain: glued # stays, the spaced one is a comment', err('read#x # y') === 'line 3: value "read#x" must be quoted')
  check('plain: a leading # is not a comment', err('# nothing') === 'line 3: value "# nothing" must be quoted')
  check('plain: unsafe start must be quoted', err('*x') === 'line 3: value "*x" must be quoted')
  check('plain: colon-space must be quoted', err('a: b') === 'line 3: value "a: b" must be quoted')
  check('plain: trailing spaces trimmed', tool1('read   ') === 'read')
  check('plain: bare CR inside a comment is not stripped', err('read #a\rb') !== undefined)

  check('double-quoted', tool1('"read"') === 'read')
  check('double-quoted with escapes', tool1(String.raw`"a\u0062c"`) === 'abc')
  check('double-quoted escaped quote', thrown(() => one(String.raw`"a\"b"`)) === undefined)
  check('double-quoted escaped quote value', tool1(String.raw`"a\"b"`) === 'a"b')
  check('double-quoted with comment', tool1('"read" # c') === 'read')
  check('double-quoted unterminated', err('"read') === 'line 3: unterminated double-quoted value')
  check('double-quoted trailing backslash unterminated', err(String.raw`"read\"`) === 'line 3: unterminated double-quoted value')
  check('double-quoted trailing text', err('"read" x') === 'line 3: unexpected text after quoted value')
  check('double-quoted bad escape', err(String.raw`"a\qb"`) === 'line 3: unsupported escape in double-quoted value')
  check('double-quoted: a glued # is still a comment', err('"read"#c') === undefined)

  check('single-quoted', tool1("'read'") === 'read')
  check("single-quoted '' escape", tool1("'it''s'") === "it's")
  check('single-quoted with comment', tool1("'read'  # c") === 'read')
  check('single-quoted unterminated', err("'read") === 'line 3: unterminated single-quoted value')
  check("single-quoted unterminated after ''", err("'read''") === 'line 3: unterminated single-quoted value')
  check('single-quoted trailing text', err("'read' x") === 'line 3: unexpected text after quoted value')
  check('single-quoted empty value refused by normalizeRule', err("''") === 'line 3: invalid tool name ""')

  // --------------------------------------------------- parseRules: lines

  const parsed = (text: string): Rule[] | string => {
    try {
      return parseRules(text)
    } catch (error) {
      return (error as Error).message
    }
  }
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

  check('empty file', same(parsed(''), []))
  check('comments and blanks only', same(parsed('# hi\n\n   \n  # x\n'), []))
  check('BOM stripped', same(parsed('\ufeffversion: 1\nallow: []\n'), []))
  check('CRLF lines', same(parsed('version: 1\r\nallow:\r\n  - tool: read\r\n'), [{ tool: 'read' }]))
  check('allow [] with comment', same(parsed('version: 1\nallow: [] # none\n'), []))
  check('allow: with comment', same(parsed('version: 1\nallow: # list\n  - tool: read\n'), [{ tool: 'read' }]))
  check('allow:[] glued', same(parsed('version: 1\nallow:[]\n'), []))
  check('allow before version', same(parsed('allow:\n  - tool: read\nversion: 1\n'), [{ tool: 'read' }]))
  check(
    'full item',
    same(
      parsed('version: 1\nallow:\n  - tool: bash\n    command: git  log *\n    mode: workspace-write\n  - tool: read\n'),
      [{ tool: 'bash', command: 'git log *', mode: 'workspace-write' }, { tool: 'read' }],
    ),
  )
  check('key order free within an item', same(parsed('version: 1\nallow:\n  - command: ls\n    tool: bash\n'), [{ tool: 'bash', command: 'ls' }]))
  check('deeper list indent', same(parsed('version: 1\nallow:\n    - tool: bash\n      command: ls\n'), [{ tool: 'bash', command: 'ls' }]))
  check('zero list indent', same(parsed('version: 1\nallow:\n- tool: read\n'), [{ tool: 'read' }]))
  check('comment between items', same(parsed('version: 1\nallow:\n  - tool: a\n  # c\n  - tool: b\n'), [{ tool: 'a' }, { tool: 'b' }]))
  check('version: quoted 1', same(parsed('version: "1"\nallow: []\n'), []))
  const commandOf = (value: string): unknown => {
    const result = parsed(`version: 1\nallow:\n  - tool: bash\n    command: ${value}\n`)
    return typeof result === 'string' ? result : result[0]?.command
  }
  check('comment: the whole whitespace run goes', commandOf('git  log   # c') === 'git log')
  check('comment: first spaced # wins', commandOf('git log # a  # b') === 'git log')
  check('comment: glued # then spaced #', commandOf('git log#x # c') === 'line 4: value "git log#x" must be quoted')
  check('comment: inner spaces kept before a word', commandOf('git  log  *') === 'git log *')
  check('comment: # at end after space', commandOf('git log #') === 'git log')
  check('comment: ## after space', commandOf('git log ##') === 'git log')

  check('tabs refused', parsed('version: 1\n\tallow: []\n') === 'line 2: tabs are not allowed')
  check('tab in a comment line is fine', same(parsed('#\tx\nversion: 1\nallow: []\n'), []))
  check('duplicate version', parsed('version: 1\nversion: 1\n') === 'line 2: duplicate "version"')
  check('unsupported version', parsed('version: 2\n') === 'line 1: unsupported version "2"')
  check('version empty', parsed('version:\n') === 'line 1: empty value')
  check('duplicate allow', parsed('version: 1\nallow: []\nallow: []\n') === 'line 3: duplicate "allow"')
  check('allow not a list', parsed('version: 1\nallow: x\n') === 'line 2: "allow" must be a list')
  check('unknown top key', parsed('version: 1\ndeny: []\n') === 'line 2: unknown key "deny"')
  check('indented line outside allow', parsed('version: 1\n  - tool: read\n') === 'line 2: unexpected indented line')
  check('indented line after allow []', parsed('version: 1\nallow: []\n  - tool: read\n') === 'line 3: unexpected indented line')
  check('unknown item key', parsed('version: 1\nallow:\n  - tool: a\n    deny: x\n') === 'line 4: unknown key "deny"')
  check('unknown first key', parsed('version: 1\nallow:\n  - name: a\n') === 'line 3: unknown key "name"')
  check('duplicate item key', parsed('version: 1\nallow:\n  - tool: a\n    tool: b\n') === 'line 4: duplicate key "tool"')
  check('field at wrong indent', parsed('version: 1\nallow:\n  - tool: a\n   command: ls\n') === 'line 4: not a rule line')
  check('field at list indent', parsed('version: 1\nallow:\n  - tool: a\n  command: ls\n') === 'line 4: not a rule line')
  check('garbage line', parsed('version: 1\nallow:\n  nope\n') === 'line 3: not a rule line')
  check('list item without space', parsed('version: 1\nallow:\n  -tool: a\n') === 'line 3: not a rule line')
  check('rule without tool', parsed('version: 1\nallow:\n  - command: ls\n') === 'line 3: rule has no tool')
  check(
    'rule without tool reported at flush by the next top key',
    parsed('version: 1\nallow:\n  - command: ls\nversion: 1\n') === 'line 3: rule has no tool',
  )
  check(
    'flush error precedes duplicate key',
    parsed('version: 1\nallow:\n  - command: ls\nallow: []\n') === 'line 3: rule has no tool',
  )
  check('invalid mode', parsed('version: 1\nallow:\n  - tool: a\n    mode: root\n') === 'line 3: invalid mode "root"')
  check('unquoted ; in a value', parsed('version: 1\nallow:\n  - tool: bash\n    command: ls; pwd\n') === 'line 4: value "ls; pwd" must be quoted')
  {
    const invalid = parsed('version: 1\nallow:\n  - tool: bash\n    command: "ls; pwd"\n')
    check('invalid command', typeof invalid === 'string' && invalid.startsWith('line 3: invalid command "ls; pwd": '))
  }
  check('empty field value', parsed('version: 1\nallow:\n  - tool: a\n    mode:\n') === 'line 4: empty value')
  check('field with empty after colon-space', parsed('version: 1\nallow:\n  - tool: a\n    mode: \n') === 'line 4: empty value')
  check('missing version', parsed('allow: []\n') === 'missing "version: 1"')
  check('missing allow', parsed('version: 1\n') === 'missing "allow"')
  check('allow: with only a comment is an empty list', same(parsed('version: 1\nallow:  # c\n'), []))
  check('allow: # after one space is a comment', same(parsed('version: 1\nallow: #c\n'), []))
  check('allow:#c glued is not a comment', parsed('version: 1\nallow:#c\n') === 'line 2: "allow" must be a list')
  check('a bare CR is not a top line', parsed('version: 1\nallow: []\r# c\n') === 'line 2: unexpected indented line')
  check('a bare CR is not a rule line', parsed('version: 1\nallow:\n  - tool: a #\rb\n') === 'line 3: not a rule line')
  check('allow with multi-space comment', same(parsed('version: 1\nallow: []    # c\n'), []))
  check('key with digits is not a top key', parsed('version: 1\nk1: x\n') === 'line 2: unexpected indented line')

  // ------------------------------------------------------------ store

  const cwd = join(home, 'project')
  check('addRule writes', (await addRule('project', cwd, { tool: 'bash', command: 'ls  *' })) === true)
  check('addRule dedups', (await addRule('project', cwd, { tool: 'bash', command: 'ls *' })) === false)
  check('addRule global', (await addRule('global', cwd, { tool: 'read' })) === true)
  check(
    'file content',
    (await readFile(rulesPath('project', cwd), 'utf8')) === 'version: 1\nallow:\n  - tool: bash\n    command: ls *\n',
  )
  check('no scratch files left', (await readdir(permissionsDir())).every((name) => name.endsWith('.yaml')))
  {
    const all = await loadAllRules(cwd, [{ tool: 'edit' }])
    check(
      'loadAllRules order: session, project, global',
      same(all.rules.map((r) => `${r.scope}:${r.tool}`), ['session:edit', 'project:bash', 'global:read']),
    )
    check('loadAllRules no errors', all.errors.length === 0)
  }
  await writeFile(rulesPath('project', cwd), 'broken\n')
  {
    const all = await loadAllRules(cwd)
    check('broken project: global still loads', same(all.rules.map((r) => r.scope), ['global']))
    check('broken project: one error naming the file', all.errors.length === 1 && all.errors[0]!.path === rulesPath('project', cwd))
  }
  await writeFile(rulesPath('global', cwd), 'broken\n')
  {
    const all = await loadAllRules(cwd)
    check('both broken: no rules', all.rules.length === 0)
    check(
      'both broken: errors in scope order',
      same(all.errors.map((e) => e.path), [rulesPath('project', cwd), rulesPath('global', cwd)]),
    )
  }
} finally {
  await rm(home, { recursive: true, force: true })
}

console.log(`permissions-matcher-smoke: ${checks} checks passed`)
