/**
 * A dependency-free test for the memory store and instruction-chain helper.
 *
 * `$DSH_HOME` points at a mkdtemp directory before anything is imported, and
 * project directories are temp directories with a `.git` dir, so nothing here
 * touches the real home. Everything is removed at the end however the run
 * turns out.
 *
 * Run with: node --experimental-strip-types tests/memory-smoke.ts
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'moqi-memory-home-'))
const work = mkdtempSync(join(tmpdir(), 'moqi-memory-work-'))
process.env['DSH_HOME'] = home

const memory = await import('../src/memory.ts')
const { save, read, forget, list, slugify, memoryDir, indexPath, renderIndexForPrompt, instructionChain, appendInstruction, projectRoot } = memory

const mode = (path: string): number => statSync(path).mode & 0o777

try {
  const project = join(work, 'proj')
  mkdirSync(join(project, '.git'), { recursive: true })
  const other = join(work, 'other')
  mkdirSync(join(other, '.git'), { recursive: true })

  // --- slugify: shape and escape attempts --------------------------------
  assert.equal(slugify('Prefers pnpm over npm'), 'prefers-pnpm-over-npm')
  assert.equal(slugify('  --Hello__World!!  '), 'hello-world')
  assert.equal(slugify('../../etc/passwd'), 'etc-passwd')
  assert.equal(slugify('a/b'), 'a-b')
  assert.equal(slugify('/abs/path'), 'abs-path')
  assert.equal(slugify('C:\\Windows\\x'), 'c-windows-x')
  assert.equal(slugify('Crème brûlée'), 'creme-brulee')
  assert.equal(slugify('x'.repeat(200)).length, 64)
  for (const bad of ['', '.', '..', '../..', '/', '中文', '   ', '---']) {
    assert.throws(() => slugify(bad), /no usable characters/, `slugify(${JSON.stringify(bad)}) must throw`)
  }
  // A long name whose 64th char is a dash does not end in one.
  assert.ok(!slugify(`${'a'.repeat(63)} b`).endsWith('-'))

  // An escape attempt lands inside the scope directory.
  const escaped = save('global', project, { name: '../../etc/passwd', description: 'nope', type: 'reference', body: 'x' })
  assert.equal(escaped.name, 'etc-passwd')
  assert.ok(readdirSync(memoryDir('global', project)).includes('etc-passwd.md'))
  assert.ok(forget('global', project, '../../etc/passwd'))

  // --- empty state -------------------------------------------------------
  assert.deepEqual(list('global', project), [])
  assert.deepEqual(list('project', project), [])
  assert.equal(renderIndexForPrompt(project), '')
  assert.equal(read('project', project, 'missing'), undefined)
  assert.equal(forget('project', project, 'missing'), false)

  // --- round trips in both scopes ----------------------------------------
  const saved = save('project', project, {
    name: 'Build command',
    description: 'use npm run build: never yarn',
    type: 'project',
    body: 'Run `npm run build`.\n---\nnot front matter\n',
  })
  assert.equal(saved.name, 'build-command')
  const back = read('project', project, 'build-command')
  assert.deepEqual(back, saved)
  assert.deepEqual(read('project', project, 'Build command'), saved, 'title resolves to the same slug')
  assert.equal(read('global', project, 'build-command'), undefined, 'scopes are separate')
  assert.equal(read('project', other, 'build-command'), undefined, 'projects are separate')

  save('global', project, { name: 'Terse answers', description: 'user wants short replies', type: 'feedback', body: 'Keep it short.' })
  assert.equal(read('global', other, 'terse-answers')?.body, 'Keep it short.\n', 'global is visible from any project')

  const file = join(memoryDir('project', project), 'build-command.md')
  assert.equal(
    readFileSync(file, 'utf8'),
    '---\nname: Build command\ndescription: use npm run build: never yarn\ntype: project\n---\nRun `npm run build`.\n---\nnot front matter\n',
  )

  // --- modes -------------------------------------------------------------
  assert.equal(mode(file), 0o600)
  assert.equal(mode(indexPath('project', project)), 0o600)
  assert.equal(mode(indexPath('global', project)), 0o600)
  assert.equal(mode(memoryDir('project', project)), 0o700)
  assert.ok(!readdirSync(memoryDir('project', project)).some((entry) => entry.endsWith('.tmp')), 'no scratch left behind')

  // --- validation --------------------------------------------------------
  assert.throws(() => save('project', project, { name: 'x', description: 'd', type: 'bogus' as 'user', body: '' }), /unknown memory type/)
  assert.throws(() => save('project', project, { name: 'x', description: '  \n ', type: 'user', body: '' }), /description/)
  assert.throws(() => save('project', project, { name: '..', description: 'd', type: 'user', body: '' }), /no usable/)

  // --- index maintenance -------------------------------------------------
  const index = indexPath('project', project)
  writeFileSync(index, `# My notes\n\nSome hand-written context.\n${readFileSync(index, 'utf8')}<!-- keep me -->\n`)
  save('project', project, { name: 'Second', description: 'two', type: 'reference', body: 'b' })
  save('project', project, { name: 'Third', description: 'three', type: 'user', body: 'c' })
  // Update in place: new title text, multi-line description collapses.
  save('project', project, { name: 'build command', description: 'updated\nhook', type: 'project', body: 'new body' })
  assert.equal(
    readFileSync(index, 'utf8'),
    [
      '# My notes',
      '',
      'Some hand-written context.',
      '- [build command](build-command.md) — updated hook',
      '<!-- keep me -->',
      '- [Second](second.md) — two',
      '- [Third](third.md) — three',
      '',
    ].join('\n'),
  )
  assert.equal(read('project', project, 'build-command')?.body, 'new body\n')
  assert.deepEqual(list('project', project).map((m) => m.name), ['build-command', 'second', 'third'])

  // Saving again never duplicates; forget removes exactly its line.
  save('project', project, { name: 'Second', description: 'two again', type: 'reference', body: 'b' })
  assert.equal(readFileSync(index, 'utf8').split('second.md').length, 2)
  assert.ok(forget('project', project, 'second'))
  assert.ok(!readFileSync(index, 'utf8').includes('second.md'))
  assert.ok(readFileSync(index, 'utf8').includes('<!-- keep me -->'))
  assert.deepEqual(list('project', project).map((m) => m.name), ['build-command', 'third'])

  // A memory file the index does not mention is still listed (after indexed ones).
  writeFileSync(join(memoryDir('project', project), 'aaa-orphan.md'), 'no front matter here\n')
  const listed = list('project', project)
  assert.deepEqual(listed.map((m) => m.name), ['build-command', 'third', 'aaa-orphan'])
  assert.equal(listed[2]?.type, 'reference')
  assert.equal(listed[2]?.body, 'no front matter here\n')
  rmSync(join(memoryDir('project', project), 'aaa-orphan.md'))

  // --- prompt rendering --------------------------------------------------
  const rendered = renderIndexForPrompt(project)
  assert.match(rendered, /memory_read/)
  assert.ok(rendered.indexOf('## Global memory') < rendered.indexOf('## Project memory'))
  assert.ok(rendered.includes('- [Terse answers](terse-answers.md) — user wants short replies'))
  assert.ok(!rendered.includes('omitted'))
  assert.ok(!rendered.includes('My notes'), 'hand-written index lines are not injected')
  // Another project sees only global memory.
  const otherRendered = renderIndexForPrompt(other)
  assert.ok(otherRendered.includes('## Global memory') && !otherRendered.includes('## Project memory'))

  // Budget: drop global before project, note the omission.
  const budgetHome = join(work, 'budget-proj')
  mkdirSync(join(budgetHome, '.git'), { recursive: true })
  for (let i = 0; i < 5; i++) {
    save('project', budgetHome, { name: `proj ${String(i)}`, description: `project fact ${String(i)}`, type: 'project', body: '' })
  }
  // Global now has 1 (terse-answers); add more.
  for (let i = 0; i < 3; i++) {
    save('global', budgetHome, { name: `glob ${String(i)}`, description: `global fact ${String(i)}`, type: 'user', body: '' })
  }
  const full = renderIndexForPrompt(budgetHome)
  assert.ok(!full.includes('omitted'))
  // instruction + blank + heading + 4 global + blank + heading + 5 project = 14 lines.
  assert.equal(full.split('\n').length, 14)
  const tight = renderIndexForPrompt(budgetHome, { maxLines: 12 })
  assert.ok(tight.split('\n').length <= 12)
  assert.match(tight, /… \d+ memories omitted/)
  for (let i = 0; i < 5; i++) assert.ok(tight.includes(`proj-${String(i)}.md`), 'project entries survive first')
  assert.ok(!tight.includes('glob-2.md'), 'global entries are dropped first')
  const tighter = renderIndexForPrompt(budgetHome, { maxLines: 7 })
  assert.ok(!tighter.includes('## Global memory'))
  assert.ok(tighter.includes('proj-0.md') && !tighter.includes('proj-4.md'), 'later project entries drop from the end')
  assert.match(tighter, /… \d+ memories omitted$/)
  const bytes = renderIndexForPrompt(budgetHome, { maxBytes: 300 })
  assert.ok(Buffer.byteLength(bytes) <= 300)
  assert.match(bytes, /omitted/)
  const tiny = renderIndexForPrompt(budgetHome, { maxBytes: 40 })
  assert.ok(Buffer.byteLength(tiny) <= 40 && tiny.endsWith('…'), 'truncated as a last resort')

  // --- instructionChain --------------------------------------------------
  const nested = join(project, 'packages', 'app')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(project, 'AGENTS.md'), 'root\n')
  writeFileSync(join(nested, 'CLAUDE.local.md'), 'local\n')
  assert.equal(projectRoot(nested), resolve(project))
  const chain = instructionChain(nested)
  const rel = (path: string): string => (path.startsWith(home) ? `$HOME${path.slice(home.length)}` : path.slice(resolve(project).length))
  assert.deepEqual(chain.map((entry) => rel(entry.path)), [
    '$HOME/AGENTS.md',
    '/AGENTS.md', '/CLAUDE.md', '/AGENTS.local.md', '/CLAUDE.local.md',
    '/packages/AGENTS.md', '/packages/CLAUDE.md', '/packages/AGENTS.local.md', '/packages/CLAUDE.local.md',
    '/packages/app/AGENTS.md', '/packages/app/CLAUDE.md', '/packages/app/AGENTS.local.md', '/packages/app/CLAUDE.local.md',
  ])
  assert.equal(chain[0]?.scope, 'global')
  assert.ok(chain.slice(1).every((entry) => entry.scope === 'project'))
  assert.deepEqual(chain.filter((entry) => entry.exists).map((entry) => rel(entry.path)), ['/AGENTS.md', '/packages/app/CLAUDE.local.md'])

  // `.git` as a file (worktree / submodule) marks a root too.
  const worktree = join(work, 'wt')
  mkdirSync(join(worktree, 'sub'), { recursive: true })
  writeFileSync(join(worktree, '.git'), 'gitdir: elsewhere\n')
  assert.equal(projectRoot(join(worktree, 'sub')), resolve(worktree))

  // No marker anywhere: the root is cwd itself, so only cwd's files.
  const loose = mkdtempSync(join(tmpdir(), 'moqi-memory-nogit-'))
  try {
    const deep = join(loose, 'a', 'b')
    mkdirSync(deep, { recursive: true })
    // Only meaningful when no ancestor of tmpdir carries a .git.
    if (projectRoot(deep) === resolve(deep)) {
      const looseChain = instructionChain(deep)
      assert.equal(looseChain.length, 5)
      assert.ok(looseChain.slice(1).every((entry) => entry.path.startsWith(`${resolve(deep)}/`)))
    }
  } finally {
    rmSync(loose, { recursive: true, force: true })
  }

  // --- appendInstruction -------------------------------------------------
  const globalAgents = join(home, 'AGENTS.md')
  appendInstruction(globalAgents, 'first rule')
  assert.equal(readFileSync(globalAgents, 'utf8'), 'first rule\n')
  assert.equal(mode(globalAgents), 0o600)
  assert.ok(instructionChain(nested)[0]?.exists)
  appendInstruction(globalAgents, 'second\nrule')
  assert.equal(readFileSync(globalAgents, 'utf8'), 'first rule\nsecond rule\n')
  const noNewline = join(project, 'AGENTS.md')
  writeFileSync(noNewline, 'no trailing newline')
  chmodSync(noNewline, 0o644)
  appendInstruction(noNewline, 'added')
  assert.equal(readFileSync(noNewline, 'utf8'), 'no trailing newline\nadded\n')
  assert.equal(mode(noNewline), 0o644, 'existing mode kept')
  const fresh = join(work, 'new-dir', 'AGENTS.md')
  appendInstruction(fresh, 'made')
  assert.equal(readFileSync(fresh, 'utf8'), 'made\n')
  assert.throws(() => appendInstruction(fresh, '   '), /nothing to append/)

  // ---------------------------------------------------------------- MemoryStore
  // The interface callers use: bound to one directory, paths handed back.
  const store = new memory.MemoryStore(project)
  const kept = store.save('project', { name: 'Deploy excludes env', description: 'tar must skip .env', type: 'feedback', body: 'Why: outage.' })
  assert.equal(kept.path, join(memoryDir('project', project), 'deploy-excludes-env.md'))
  assert.equal(readFileSync(kept.path, 'utf8').includes('tar must skip .env'), true, 'the path is the real file')
  assert.equal(store.read('project', 'Deploy excludes env')?.path, kept.path)
  assert.equal(store.read('project', 'nope'), undefined)
  assert.deepEqual(store.list('project').map((m) => m.name).includes('deploy-excludes-env'), true)
  assert.ok(store.list('project').every((m) => m.path.endsWith(`${m.name}.md`)))
  assert.equal(store.indexFile('project'), indexPath('project', project))
  assert.match(store.promptIndex(), /Deploy excludes env/)
  assert.deepEqual(store.instructions(), instructionChain(project))
  // A store for another directory sees its own project scope and the shared global one.
  const elsewhereStore = new memory.MemoryStore(other)
  assert.equal(elsewhereStore.read('project', 'deploy-excludes-env'), undefined)
  assert.equal(store.forget('project', 'deploy-excludes-env'), true)
  assert.equal(store.forget('project', 'deploy-excludes-env'), false)

  // ---------------------------------------------------------------- # quick-add
  const { quickNote } = memory
  assert.equal(quickNote('# use pnpm, not npm'), 'use pnpm, not npm')
  assert.equal(quickNote('   #   spaced out  '), 'spaced out', 'surrounding blanks are trimmed, as the composer does')
  assert.equal(quickNote('#   padded   '.trimStart()), 'padded')
  assert.equal(quickNote('#'), undefined)
  assert.equal(quickNote('# '), undefined)
  assert.equal(quickNote('#tag please'), undefined, '#tag is a prompt')
  assert.equal(quickNote('# Heading\nand a body'), undefined, 'a multi-line paste is a prompt')
  assert.equal(quickNote('plain prompt'), undefined)

  const notes = new memory.MemoryStore(project)
  const first = notes.saveNote('project', 'tests run with make check')
  assert.equal(first.title, 'tests run with make check')
  assert.equal(first.type, 'project')
  assert.equal(first.body, 'tests run with make check')
  const again = notes.saveNote('project', 'tests run with make check')
  assert.equal(again.title, 'tests run with make check 2', 'a colliding note gets a numbered name')
  assert.equal(notes.read('project', first.name)?.body.trim(), 'tests run with make check', 'the earlier memory is untouched')
  const long = notes.saveNote('global', 'always answer in English even when the question is asked in Dutch, unless asked otherwise')
  assert.ok(long.title.endsWith('…') && long.title.length <= 61, 'a long note is titled by its first words')
  assert.equal(long.type, 'user')
  assert.ok(long.body.includes('unless asked otherwise'), 'the body keeps the whole note')
  notes.forget('project', first.name)
  notes.forget('project', again.name)
  notes.forget('global', long.name)

  const deepDir = join(project, "pkg", "deep")
  mkdirSync(deepDir, { recursive: true })
  const deepNotes = new memory.MemoryStore(deepDir)
  const projectFile = deepNotes.addInstruction('project', 'prefer small modules')
  assert.equal(projectFile, join(projectRoot(deepDir), "AGENTS.md"), 'project notes go to the root AGENTS.md')
  assert.ok(readFileSync(projectFile, 'utf8').endsWith('- prefer small modules\n'))
  deepNotes.addInstruction('project', 'second rule')
  assert.ok(readFileSync(projectFile, 'utf8').endsWith('- prefer small modules\n- second rule\n'))
  const globalFile = deepNotes.addInstruction('global', 'be brief')
  assert.equal(globalFile, join(home, 'AGENTS.md'))
  assert.ok(readFileSync(globalFile, 'utf8').endsWith('\n- be brief\n'), 'appended after what was there')

  // One $DSH_HOME rule for every moqi path, the Harness's own.
  const { dshHome } = await import('../src/sessions-store.ts')
  const { homedir } = await import('node:os')
  assert.equal(dshHome({ DSH_HOME: '   ' }), join(homedir(), '.dsh'), 'whitespace means unset')
  assert.equal(dshHome({ DSH_HOME: '' }), join(homedir(), '.dsh'))
  assert.equal(dshHome({}), join(homedir(), '.dsh'))
  assert.equal(dshHome({ DSH_HOME: 'rel/dir' }), resolve('rel/dir'), 'relative paths are resolved')
  assert.equal(dshHome(), resolve(home))

  console.log('memory-smoke: ok')
} finally {
  rmSync(home, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
}
