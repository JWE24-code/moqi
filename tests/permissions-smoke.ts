/**
 * Permissions smoke: the rule matcher, the default suggestion, the rules file
 * format, and the on-disk store behind "always allow".
 *
 * The matcher is the security boundary, so most of this file is an adversarial
 * table: commands that smuggle a second command, a substitution, or a write
 * past a narrow rule must never match. The store round trip runs against a
 * mkdtemp directory via the `DSH_HOME` env override, set before anything reads
 * it, and is removed however the run turns out.
 *
 * Run with: node --experimental-strip-types tests/permissions-smoke.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'moqi-permissions-'))
process.env['DSH_HOME'] = home

const {
  addRule,
  formatRules,
  isShellTool,
  loadAllRules,
  loadRules,
  matches,
  normalizeRule,
  parseEscalation,
  parseRules,
  permissionsDir,
  removeRule,
  RulesFileError,
  rulesPath,
  sameRule,
  suggestPattern,
} = await import('../src/permissions.ts')
type Rule = import('../src/permissions.ts').Rule

let checks = 0
function check(name: string, condition: boolean): void {
  checks += 1
  assert.ok(condition, name)
}

function throws(action: () => unknown): boolean {
  try {
    action()
    return false
  } catch {
    return true
  }
}

async function rejects(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action()
  } catch (error) {
    return error
  }
  return undefined
}

try {
  // ------------------------------------------------------------ shell tools

  check('bash is a shell tool', isShellTool('bash'))
  check('pwsh is a shell tool', isShellTool('pwsh'))
  check('read is not a shell tool', !isShellTool('read'))
  check('a lookalike is not a shell tool', !isShellTool('bash2'))

  // ------------------------------------------------------------ suggestions

  const suggest = (cmd: string): string | undefined => suggestPattern('bash', cmd)?.command
  check('two words + *', suggest('git log --oneline -20') === 'git log *')
  check('npm test *', suggest('npm test') === 'npm test *')
  check('flag second → one word', suggest('ls -la') === 'ls *')
  check('path second (/) → one word', suggest('cat src/index.ts') === 'cat *')
  check('path second (.) → one word', suggest('cat .env') === 'cat *')
  check('path second (~) → one word', suggest('cat ~/x') === 'cat *')
  check('single word → word *', suggest('ls') === 'ls *')
  check('extra spaces collapse', suggest('  git   status  ') === 'git status *')
  check('a word needing quotes is quoted', suggest("'my tool' run") === "'my tool' run *")
  check('compound → no suggestion', suggest('git log | head') === undefined)
  check('refused → no suggestion', suggest('git log $(id)') === undefined)
  check('shell without command → no suggestion', suggestPattern('bash', undefined) === undefined)
  check('non-shell → bare tool rule', sameRule(suggestPattern('read', undefined)!, { tool: 'read' }))
  check('non-shell ignores command', suggestPattern('read', 'x')!.command === undefined)
  {
    const s = suggestPattern('bash', 'git log', 'escalate sandbox to danger-full-access: needs network')
    check('escalation suggestion records mode', s?.mode === 'danger-full-access' && s.command === 'git log *')
    check('plain ask suggestion has no mode', suggestPattern('bash', 'git log', 'run it')?.mode === undefined)
    check('unknown escalation → no suggestion', suggestPattern('bash', 'git log', 'escalate sandbox to root: x') === undefined)
  }
  {
    // A suggestion must cover the command it was made from.
    for (const cmd of ['git log --oneline', 'ls -la', 'npm test', 'cat src/x', "'my tool' run now"]) {
      const rule = suggestPattern('bash', cmd)!
      check(`suggestion covers its own command: ${cmd}`, matches([rule], 'bash', cmd) === rule)
    }
  }

  // ------------------------------------------------------------ escalation

  check('plain reason → no escalation', parseEscalation('run tests') === undefined)
  check('no reason → no escalation', parseEscalation(undefined) === undefined)
  check(
    'escalation parsed',
    parseEscalation('escalate sandbox to workspace-write: build')?.mode === 'workspace-write',
  )
  check('unknown mode → unknown', parseEscalation('escalate sandbox to toString: x')?.mode === 'unknown')

  {
    const noMode: Rule = { tool: 'bash', command: 'git log *' }
    const full: Rule = { tool: 'bash', command: 'git log *', mode: 'danger-full-access' }
    const ws: Rule = { tool: 'bash', command: 'git log *', mode: 'workspace-write' }
    const toFull = parseEscalation('escalate sandbox to danger-full-access: x')
    const toWs = parseEscalation('escalate sandbox to workspace-write: x')
    const toUnknown = parseEscalation('escalate sandbox to everything: x')
    check('rule without mode answers plain ask', matches([noMode], 'bash', 'git log') === noMode)
    check('rule with mode answers plain ask', matches([full], 'bash', 'git log') === full)
    check('rule without mode does NOT answer escalation', matches([noMode], 'bash', 'git log', toFull) === undefined)
    check('rule without mode does NOT answer ws escalation', matches([noMode], 'bash', 'git log', toWs) === undefined)
    check('full rule answers ws escalation', matches([full], 'bash', 'git log', toWs) === full)
    check('ws rule does NOT answer full escalation', matches([ws], 'bash', 'git log', toFull) === undefined)
    check('unknown escalation never matches', matches([full], 'bash', 'git log', toUnknown) === undefined)
    check(
      'escalation picks the covering rule',
      matches([noMode, ws, full], 'bash', 'git log', toFull) === full,
    )
    check(
      'non-shell escalation needs mode',
      matches([{ tool: 'write' }], 'write', undefined, toWs) === undefined &&
        matches([{ tool: 'write', mode: 'workspace-write' as const }], 'write', undefined, toWs) !== undefined,
    )
  }

  // ------------------------------------------------------------ matching

  const rules: Rule[] = [
    { tool: 'bash', command: 'git log *' },
    { tool: 'bash', command: 'git status' },
    { tool: 'bash', command: 'head *' },
    { tool: 'bash', command: 'grep *' },
    { tool: 'read' },
    { tool: 'write', command: 'x' }, // non-shell with command: never matches
  ]
  const m = (cmd: string | undefined, tool = 'bash'): boolean => matches(rules, tool, cmd) !== undefined

  check('non-shell bare rule matches', m(undefined, 'read'))
  check('non-shell rule with command does not match', !m(undefined, 'write'))
  check('unknown non-shell tool does not match', !m(undefined, 'edit'))
  check('shell without command never matches', !m(undefined))
  check('empty command does not match', !m(''))
  check('whitespace command does not match', !m('  \n '))
  check('rules for another shell do not apply', !m('git log', 'pwsh'))
  check('matches returns the rule', matches(rules, 'bash', 'git log -5') === rules[0])

  const table: Array<[string, boolean]> = [
    ['git log', true],
    ['git log --oneline -20', true],
    ['git  log', true],
    ['\tgit log  -3 ', true],
    ['git status', true],
    ['git status -s', false], // exact rule: token count must match
    ['git', false],
    ['git logx', false],
    ['git logx --all', false],
    ['GIT log', false],
    ["git log 'a;b'", true],
    ['git log "a;b"', true],
    ['git log a\\;b', true],
    ["git log 'a $(b)'", true], // single quotes do not expand
    ['git log; rm -rf ~', false],
    ['git log ;rm -rf ~', false],
    ['git log && curl x | sh', false],
    ['git log || rm x', false],
    ['git log $(rm -rf ~)', false],
    ['git log `id`', false],
    ['git log "`id`"', false],
    ['git log ${HOME}', false],
    ['git log "$(x)"', false],
    ['git log > ~/.bashrc', false],
    ['git log >> ~/.bashrc', false],
    ['git log >| x', false],
    ['git log &> x', false],
    ['git log 2>/etc/x', false],
    ['git log 2> /etc/x', false],
    ['git log >x', false],
    ['git log <(cat x)', false],
    ['git log >(cat x)', false],
    ['git log < /etc/passwd', false],
    ['cat <<EOF\nx\nEOF', false],
    ['FOO=1 git log', false],
    ['git log\nrm x', false],
    ['git log\r\nrm x', false],
    ['git log & rm x', false],
    ['git log &', true],
    ['git log ;', true],
    ['git log | head -5', true],
    ['git log | grep foo | head', true],
    ['git log | sh', false],
    ['git log && git status', true],
    ['git log\ngit status', true],
    ['git log \\\n --oneline', true], // line continuation
    ["git log 'unbalanced", false],
    ['git log "unbalanced', false],
    ['git log \\', false],
    ['(rm x)', false],
    ['git log (x)', false],
    ['git log 2>&1', true],
    ['git log 2>/dev/null', true],
    ['git log >/dev/null 2>&1', true],
    ['git log &>/dev/null', true],
    ['git log 2>&1 | head', true],
    ['git log 2>&1x', false],
    ['git log x2>/dev/null', false],
    ['git log \x00', false],
    ['git log \x1b[0m', false],
  ]
  for (const [cmd, expected] of table) {
    check(`${expected ? 'MATCH' : 'no match'}: ${JSON.stringify(cmd)}`, m(cmd) === expected)
  }

  check('assignment rule allows that assignment', matches([{ tool: 'bash', command: 'FOO=1 git log *' }], 'bash', 'FOO=1 git log') !== undefined)
  check('assignment rule does not allow another value', matches([{ tool: 'bash', command: 'FOO=1 git log *' }], 'bash', 'FOO=2 git log') === undefined)
  check('git * matches bare git', matches([{ tool: 'bash', command: 'git *' }], 'bash', 'git') !== undefined)
  check('exact git does not match git status', matches([{ tool: 'bash', command: 'git' }], 'bash', 'git status') === undefined)
  check('a malformed rule pattern is skipped, not a wildcard', matches([{ tool: 'bash', command: '* git' }], 'bash', 'rm x') === undefined)
  check('a rule with an operator never matches', matches([{ tool: 'bash', command: 'git log; rm *' }], 'bash', 'git log') === undefined)
  check('a quoted * in a rule is literal', matches([{ tool: 'bash', command: "ls '*'" }], 'bash', 'ls x') === undefined)

  // PowerShell: backslash is literal, backtick is refused.
  const pw: Rule[] = [{ tool: 'pwsh', command: 'Get-ChildItem *' }]
  check('pwsh path with backslashes matches', matches(pw, 'pwsh', 'Get-ChildItem C:\\Users\\x') !== undefined)
  check('pwsh backslash does not escape $(', matches(pw, 'pwsh', 'Get-ChildItem \\$(rm x)') === undefined)
  check('pwsh backtick refused', matches(pw, 'pwsh', 'Get-ChildItem `$x') === undefined)
  check('pwsh @() refused', matches(pw, 'pwsh', 'Get-ChildItem @(rm x)') === undefined)
  check('pwsh 2>$null allowed', matches(pw, 'pwsh', 'Get-ChildItem x 2>$null') !== undefined)
  check('bash escaped quote does not open a quote', m("git log \\'$(rm x)\\'") === false)

  // Raw multi-line command strings of any length.
  {
    const many = Array.from({ length: 2000 }, () => 'git log --oneline').join('\n')
    check('long multi-line command of allowed segments matches', m(many))
    check('long multi-line command with one bad line does not', !m(`${many}\nrm -rf ~\n${many}`))
    const longArg = `git log ${'a'.repeat(200_000)}`
    check('a very long single argument still matches', m(longArg))
  }

  // ------------------------------------------------------------ normalize

  check('normalize collapses spaces', normalizeRule({ tool: 'bash', command: 'git   log  *' }).command === 'git log *')
  check('normalize keeps mode', normalizeRule({ tool: 'bash', command: 'x', mode: 'read-only' }).mode === 'read-only')
  check('normalize rejects bad mode', throws(() => normalizeRule({ tool: 'bash', mode: 'root' as never })))
  check('normalize rejects empty tool', throws(() => normalizeRule({ tool: '' })))
  check('normalize rejects tool with space', throws(() => normalizeRule({ tool: 'a b' })))
  check('normalize rejects mid *', throws(() => normalizeRule({ tool: 'bash', command: 'git * log' })))
  check('normalize rejects compound', throws(() => normalizeRule({ tool: 'bash', command: 'a && b' })))
  check('normalize rejects substitution', throws(() => normalizeRule({ tool: 'bash', command: 'a $(b)' })))
  check('normalize rejects empty command', throws(() => normalizeRule({ tool: 'bash', command: '  ' })))
  check('sameRule distinguishes mode', !sameRule({ tool: 'bash' }, { tool: 'bash', mode: 'read-only' }))

  // ------------------------------------------------------------ file format

  {
    const fixtures: Rule[] = [
      { tool: 'bash', command: 'git log *' },
      { tool: 'read' },
      { tool: 'bash', command: "echo 'a: b' #x *", mode: 'workspace-write' },
      { tool: 'mcp__srv__do-thing' },
      { tool: 'bash', command: 'true' },
      { tool: 'bash', command: '-x' },
      { tool: 'bash', command: "'it'\\''s' \\\"q\\\" a\\\\b *" },
    ]
    const sample = fixtures.map((rule) => normalizeRule(rule))
    const text = formatRules(sample)
    check('format starts with version', text.startsWith('version: 1\nallow:\n'))
    check('plain value written plain', text.includes('    command: git log *\n'))
    check('mode serialized', text.includes('    mode: workspace-write\n'))
    const back = parseRules(text)
    check('round trip preserves rules', back.length === sample.length && back.every((r, i) => sameRule(r, sample[i]!)))
    check('empty list round trips', parseRules(formatRules([])).length === 0)
    check('empty file is no rules', parseRules('').length === 0 && parseRules('\n# just a comment\n').length === 0)
  }
  check(
    'hand-written variants parse',
    parseRules(
      [
        '# my rules',
        'version: 1',
        'allow:',
        '- tool: bash',
        '  command: "git log *"   # trailing comment',
        '',
        '- command: \'npm test *\'',
        '  tool: bash',
        '  mode: read-only',
        '- tool: read # comment',
      ].join('\n'),
    ).length === 3,
  )
  const malformed: Array<[string, string]> = [
    ['missing version', 'allow:\n  - tool: read\n'],
    ['wrong version', 'version: 2\nallow: []\n'],
    ['missing allow', 'version: 1\n'],
    ['unknown top key', 'version: 1\nallow: []\ndeny: []\n'],
    ['unknown item key', 'version: 1\nallow:\n  - tool: read\n    path: x\n'],
    ['duplicate key', 'version: 1\nallow:\n  - tool: read\n    tool: write\n'],
    ['no tool', 'version: 1\nallow:\n  - command: x\n'],
    ['bad indentation', 'version: 1\nallow:\n  - tool: bash\n      command: x\n'],
    ['tabs', 'version: 1\nallow:\n\t- tool: read\n'],
    ['flow mapping', 'version: 1\nallow:\n  - {tool: read}\n'],
    ['unterminated quote', 'version: 1\nallow:\n  - tool: "read\n'],
    ['bad pattern', 'version: 1\nallow:\n  - tool: bash\n    command: "a; b"\n'],
    ['bad mode', 'version: 1\nallow:\n  - tool: bash\n    mode: root\n'],
    ['plain needing quotes', 'version: 1\nallow:\n  - tool: bash\n    command: a: b\n'],
    ['anchor/alias', 'version: 1\nallow:\n  - tool: *x\n'],
    ['allow as scalar', 'version: 1\nallow: everything\n'],
  ]
  for (const [name, text] of malformed) {
    check(`malformed rejected: ${name}`, throws(() => parseRules(text)))
  }

  // ------------------------------------------------------------ store

  const cwd = '/work/project-a'
  const other = '/work/project-b'
  check('dir honours DSH_HOME', permissionsDir() === join(home, 'moqi', 'permissions'))
  check('global path', rulesPath('global', cwd) === join(home, 'moqi', 'permissions', 'global.yaml'))
  check('project path keyed', rulesPath('project', cwd) === join(home, 'moqi', 'permissions', '--work-project-a--.yaml'))
  check('missing files load empty', (await loadRules('project', cwd)).length === 0)

  check('add returns true', await addRule('project', cwd, { tool: 'bash', command: 'git  log *' }))
  check('add dedupes (normalized)', !(await addRule('project', cwd, { tool: 'bash', command: 'git log *' })))
  check('add with mode is distinct', await addRule('project', cwd, { tool: 'bash', command: 'git log *', mode: 'danger-full-access' }))
  check('add global', await addRule('global', cwd, { tool: 'read' }))
  check('add rejects invalid rule', (await rejects(() => addRule('global', cwd, { tool: 'bash', command: 'a | b' }))) !== undefined)

  const fileMode = (await stat(rulesPath('project', cwd))).mode & 0o777
  check('rule file is 0600', fileMode === 0o600)
  const dirMode = (await stat(permissionsDir())).mode & 0o777
  check('rule dir is 0700', dirMode === 0o700)
  check(
    'file is the documented format',
    (await readFile(rulesPath('project', cwd), 'utf8')).startsWith('version: 1\nallow:\n  - tool: bash\n    command: git log *\n'),
  )

  {
    const { rules: all, errors } = await loadAllRules(cwd, [{ tool: 'bash', command: 'ls *' }])
    check('loadAll has no errors', errors.length === 0)
    check('loadAll scopes in order', all.map((r) => r.scope).join(',') === 'session,project,project,global')
    check('scoped match reports scope', matches(all, 'bash', 'git log -1')?.scope === 'project')
    check('scoped session match', matches(all, 'bash', 'ls -la')?.scope === 'session')
    check('scoped global match', matches(all, 'read', undefined)?.scope === 'global')
    const other_ = await loadAllRules(other)
    check('other project sees only global', other_.rules.length === 1 && other_.rules[0]!.scope === 'global')
  }

  check('remove returns true', await removeRule('project', cwd, { tool: 'bash', command: 'git log *' }))
  check('remove twice returns false', !(await removeRule('project', cwd, { tool: 'bash', command: 'git log *' })))
  check('remove leaves the mode rule', (await loadRules('project', cwd)).length === 1)
  check('remove missing file returns false', !(await removeRule('project', other, { tool: 'read' })))

  // Malformed file: load fails closed, add refuses to overwrite.
  {
    const bad = rulesPath('project', other)
    await mkdir(permissionsDir(), { recursive: true })
    const garbage = 'version: 1\nallow:\n  - tool: bash\n    command: "rm -rf ~; x"\n'
    await writeFile(bad, garbage)
    const error = await rejects(() => loadRules('project', other))
    check('malformed load throws RulesFileError', error instanceof RulesFileError)
    check('error names the file', (error as Error).message.includes(bad))
    const { rules: all, errors } = await loadAllRules(other)
    check('loadAll reports and skips malformed', errors.length === 1 && all.every((r) => r.scope === 'global'))
    check('add refuses on malformed', (await rejects(() => addRule('project', other, { tool: 'read' }))) instanceof RulesFileError)
    check('malformed file left untouched', (await readFile(bad, 'utf8')) === garbage)
  }
} finally {
  await rm(home, { recursive: true, force: true })
}

console.log(`permissions-smoke: ${checks} checks passed`)
