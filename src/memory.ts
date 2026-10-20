/**
 * Agent-written memory and the instruction-file chain, as a pure file store.
 *
 * Memory lives under `$DSH_HOME/memory/` (global scope) and
 * `$DSH_HOME/memory/projects/<projectKey(cwd)>/` (project scope). Each scope
 * directory holds one `<slug>.md` per memory — a small front matter block
 * (`name`, `description`, `type`) and a free-form body — plus a `MEMORY.md`
 * index with one `- [Title](slug.md) — description` line per memory. The index
 * is also a file people edit by hand, so lines that are not memory links are
 * preserved verbatim and memory lines keep their position across updates.
 *
 * The memory *files* are the source of truth: {@link list} reads them, and
 * {@link renderIndexForPrompt} renders from that list, so a stale or hand-
 * mangled index line can never put a memory the model cannot read into the
 * prompt.
 *
 * Every name passes through {@link slugify}, whose output alphabet is
 * `[a-z0-9-]`: no separator, no dot, no way out of the scope directory.
 *
 * All I/O is synchronous on purpose: the files are tiny, and the callers — a
 * tool handler, a panel render, the prompt-section snapshot — all want the
 * answer before they continue.
 *
 * Callers use {@link MemoryStore} (at the end of this file), bound to one
 * session directory; the functions before it are its implementation, exported
 * for this module's own tests. `$DSH_HOME` comes from `dshHome` in
 * `sessions-store.ts`, the one resolver every moqi path shares.
 *
 * Instruction discovery ({@link instructionChain}) mirrors the defaults of
 * `@deepseek-ai/dsh-agent-instructions` (`discoverInstructionFiles` in its
 * `lib/index.js`) without importing it.
 * @module moqi-tui/memory
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { dshHome, projectKey } from './sessions-store.ts'

/** Where a memory lives: shared by every project, or tied to one. */
export type MemoryScope = 'global' | 'project'

/** What kind of fact a memory records. */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

/** The memory types, in the order a picker should offer them. */
export const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference']

/** One stored memory. */
export interface Memory {
  /** The slug: file name without `.md`, and the key every call takes. */
  name: string
  /** Human title, as written in front matter `name` and the index link. */
  title: string
  /** One-line hook shown in the index. */
  description: string
  type: MemoryType
  body: string
  scope: MemoryScope
}

/** What a caller supplies to {@link save}. `name` is the title; its slug is the key. */
export interface MemoryInput {
  name: string
  description: string
  type: MemoryType
  body: string
}

/** One candidate instruction file the Harness would load if it exists. */
export interface InstructionFile {
  path: string
  scope: MemoryScope
  exists: boolean
}

const INDEX_FILE = 'MEMORY.md'
const MAX_SLUG = 64
const INDEX_LINE = /^- \[[^\]]*\]\(([a-z0-9-]+)\.md\)/

/** The directory one scope's memories live in. */
export function memoryDir(scope: MemoryScope, cwd: string): string {
  const root = join(dshHome(), 'memory')
  return scope === 'global' ? root : join(root, 'projects', projectKey(resolve(cwd)))
}

/** The `MEMORY.md` index path for a scope — what `/memory` opens in `$EDITOR`. */
export function indexPath(scope: MemoryScope, cwd: string): string {
  return join(memoryDir(scope, cwd), INDEX_FILE)
}

/** The file one memory lives in; `name` is slugified first. */
export function memoryPath(scope: MemoryScope, cwd: string, name: string): string {
  return join(memoryDir(scope, cwd), `${slugify(name)}.md`)
}

/**
 * A lowercase kebab slug over `[a-z0-9-]`, at most 64 characters.
 *
 * Accents fold to their base letter; every other run of non-alphanumerics —
 * slashes, dots, spaces, CJK — becomes one dash. The alphabet alone makes a
 * path escape impossible; an input with nothing slug-worthy left throws
 * rather than inventing a name.
 */
export function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SLUG)
  const trimmed = trimDashes(slug)
  if (trimmed === '') throw new Error(`memory name has no usable characters: ${JSON.stringify(input)}`)
  return trimmed
}

/** Strip leading and trailing dashes by index, not by a backtracking regex. */
function trimDashes(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && value[start] === '-') start += 1
  while (end > start && value[end - 1] === '-') end -= 1
  return value.slice(start, end)
}

/** Collapse a value onto one line, so it cannot break front matter or the index. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function isMemoryType(value: string): value is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(value)
}

/** Write a file atomically (scratch file + rename), creating its directory. */
function writeAtomic(path: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const scratch = `${path}.${String(process.pid)}.tmp`
  try {
    writeFileSync(scratch, content, { encoding: 'utf8', mode })
    renameSync(scratch, path)
  } catch (error) {
    rmSync(scratch, { force: true })
    throw error
  }
}

/** File contents, or undefined when the file is not there. */
function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function encodeMemory(memory: Memory): string {
  const body = memory.body.endsWith('\n') || memory.body === '' ? memory.body : `${memory.body}\n`
  return `---\nname: ${memory.title}\ndescription: ${memory.description}\ntype: ${memory.type}\n---\n${body}`
}

/**
 * Parse a memory file: a `---` fence, `key: value` lines, a `---` fence, body.
 * A file without that shape still reads, as an untyped `reference` whose body
 * is the whole file — a hand-made memory should not vanish from the list.
 */
function decodeMemory(raw: string, slug: string, scope: MemoryScope): Memory {
  const memory: Memory = { name: slug, title: slug, description: '', type: 'reference', body: raw, scope }
  const lines = raw.split('\n')
  if (lines[0]?.trim() !== '---') return memory
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (close === -1) return memory
  for (const line of lines.slice(1, close)) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (key === 'name' && value !== '') memory.title = value
    else if (key === 'description') memory.description = value
    else if (key === 'type' && isMemoryType(value)) memory.type = value
  }
  memory.body = lines.slice(close + 1).join('\n')
  return memory
}

function indexLine(memory: Memory): string {
  const title = memory.title.replace(/[[\]]/g, '')
  return `- [${title}](${memory.name}.md) — ${memory.description}`
}

/** The slug a `MEMORY.md` line links to, or undefined for a hand-written line. */
function linkedSlug(line: string): string | undefined {
  return INDEX_LINE.exec(line)?.[1]
}

/**
 * Rewrite the index: replace or remove the line(s) for `slug`, keeping every
 * other line where it is. A new memory's line is appended.
 */
function updateIndex(scope: MemoryScope, cwd: string, slug: string, line: string | undefined): void {
  const path = indexPath(scope, cwd)
  const raw = readIfPresent(path) ?? ''
  const lines = raw === '' ? [] : raw.replace(/\n$/, '').split('\n')
  const out: string[] = []
  let placed = false
  for (const existing of lines) {
    if (linkedSlug(existing) !== slug) out.push(existing)
    else if (line !== undefined && !placed) {
      out.push(line)
      placed = true
    }
  }
  if (line !== undefined && !placed) out.push(line)
  writeAtomic(path, out.length === 0 ? '' : `${out.join('\n')}\n`)
}

/**
 * Create or replace a memory. Saving a name whose slug already exists
 * replaces that memory and keeps its index line's position.
 * @returns the memory as stored.
 * @throws on an unusable name, an unknown type, an empty description, or I/O failure.
 */
export function save(scope: MemoryScope, cwd: string, input: MemoryInput): Memory {
  if (!isMemoryType(input.type)) throw new Error(`unknown memory type: ${String(input.type)}`)
  const description = oneLine(input.description)
  if (description === '') throw new Error('a memory needs a one-line description')
  const memory: Memory = {
    name: slugify(input.name),
    title: oneLine(input.name),
    description,
    type: input.type,
    body: input.body,
    scope,
  }
  writeAtomic(join(memoryDir(scope, cwd), `${memory.name}.md`), encodeMemory(memory))
  updateIndex(scope, cwd, memory.name, indexLine(memory))
  return memory
}

/** One memory, or undefined when it does not exist. `name` may be a title or slug. */
export function read(scope: MemoryScope, cwd: string, name: string): Memory | undefined {
  const slug = slugify(name)
  const raw = readIfPresent(join(memoryDir(scope, cwd), `${slug}.md`))
  return raw === undefined ? undefined : decodeMemory(raw, slug, scope)
}

/**
 * Remove a memory's file and its index line.
 * @returns whether there was a memory file to remove.
 */
export function forget(scope: MemoryScope, cwd: string, name: string): boolean {
  const slug = slugify(name)
  const path = join(memoryDir(scope, cwd), `${slug}.md`)
  const existed = readIfPresent(path) !== undefined
  rmSync(path, { force: true })
  if (readIfPresent(indexPath(scope, cwd)) !== undefined) updateIndex(scope, cwd, slug, undefined)
  return existed
}

/**
 * Every memory in a scope, in index order; memories the index does not
 * mention follow alphabetically. A missing scope directory is an empty list.
 */
export function list(scope: MemoryScope, cwd: string): Memory[] {
  const dir = memoryDir(scope, cwd)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const slugs = new Set(
    entries
      .filter((entry) => entry !== INDEX_FILE && /^[a-z0-9-]+\.md$/.test(entry))
      .map((entry) => entry.slice(0, -3)),
  )
  const ordered: string[] = []
  for (const line of (readIfPresent(join(dir, INDEX_FILE)) ?? '').split('\n')) {
    const slug = linkedSlug(line)
    if (slug !== undefined && slugs.delete(slug)) ordered.push(slug)
  }
  ordered.push(...[...slugs].sort((a, b) => a.localeCompare(b)))
  const memories: Memory[] = []
  for (const slug of ordered) {
    const raw = readIfPresent(join(dir, `${slug}.md`))
    if (raw !== undefined) memories.push(decodeMemory(raw, slug, scope))
  }
  return memories
}

/** Budget for {@link renderIndexForPrompt}. */
export interface IndexBudget {
  maxLines?: number
  maxBytes?: number
}

const PROMPT_INSTRUCTION =
  'Saved memories (current list — it replaces any earlier memory list in this conversation). ' +
  'Call memory_read with a memory\'s name to read it in full when it is relevant.'

function renderSections(global: Memory[], project: Memory[], omitted: number): string {
  const parts: string[] = [PROMPT_INSTRUCTION]
  if (global.length > 0) parts.push('', '## Global memory', ...global.map(indexLine))
  if (project.length > 0) parts.push('', '## Project memory', ...project.map(indexLine))
  if (omitted > 0) parts.push('', `… ${String(omitted)} ${omitted === 1 ? 'memory' : 'memories'} omitted`)
  return parts.join('\n')
}

function fits(text: string, maxLines: number, maxBytes: number): boolean {
  return text.split('\n').length <= maxLines && Buffer.byteLength(text, 'utf8') <= maxBytes
}

/** Cut a string to at most `maxBytes` UTF-8 bytes, ending in an ellipsis. */
function cutToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const chars = [...text]
  while (chars.length > 0 && Buffer.byteLength(`${chars.join('')}…`, 'utf8') > maxBytes) chars.pop()
  return `${chars.join('')}…`
}

/**
 * The text of the `moqi:memory` prompt section: an instruction sentence, the
 * global index, then the project index. Empty string when there are no
 * memories, so no section is added.
 *
 * Over budget, whole entries are dropped — global ones first, since project
 * memory is more specific, and within a scope from the end of the index — and
 * a visible `… N memories omitted` line is appended. If even that does not
 * fit, the text is truncated to the byte budget.
 */
export function renderIndexForPrompt(cwd: string, budget: IndexBudget = {}): string {
  const maxLines = budget.maxLines ?? 200
  const maxBytes = budget.maxBytes ?? 8192
  const global = list('global', cwd)
  const project = list('project', cwd)
  const total = global.length + project.length
  if (total === 0) return ''

  const full = renderSections(global, project, 0)
  if (fits(full, maxLines, maxBytes)) return full

  // Priority order: project entries first, then global. Keep the longest
  // prefix of that order that fits alongside the omission note.
  const priority = [...project, ...global]
  let kept = 0
  for (let count = 1; count <= priority.length; count++) {
    const chosen = priority.slice(0, count)
    const text = renderSections(
      global.filter((memory) => chosen.includes(memory)),
      project.filter((memory) => chosen.includes(memory)),
      total - count,
    )
    if (!fits(text, maxLines, maxBytes)) break
    kept = count
  }
  const chosen = priority.slice(0, kept)
  const text = renderSections(
    global.filter((memory) => chosen.includes(memory)),
    project.filter((memory) => chosen.includes(memory)),
    total - kept,
  )
  if (fits(text, maxLines, maxBytes)) return text
  // Not even the instruction and note fit: truncate as a last resort.
  return cutToBytes(text.split('\n').slice(0, Math.max(1, maxLines)).join('\n'), maxBytes)
}

const BASE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md']
const LOCAL_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md']
const ROOT_MARKERS = ['.git']

/** Whether a path exists at all; a missing path is false, any other failure throws. */
function markerExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The project root the Harness would pick: the nearest ancestor (or `cwd`
 * itself) holding a `.git` entry of any kind; with none, `cwd` itself.
 */
export function projectRoot(cwd: string): string {
  let current = resolve(cwd)
  for (;;) {
    if (ROOT_MARKERS.some((marker) => markerExists(join(current, marker)))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/**
 * Every instruction file the Harness's default discovery would load for
 * `cwd`, in its precedence order, *including* ones that do not exist yet
 * (`exists: false`) so a panel can offer to create them. Filter on `exists`
 * for what is actually loaded.
 *
 * Order: `$DSH_HOME/AGENTS.md`, then each directory from the project root
 * down to `cwd`, each contributing `AGENTS.md`, `CLAUDE.md`,
 * `AGENTS.local.md`, `CLAUDE.local.md`. Without a `.git` marker the root is
 * `cwd` itself, so only `cwd`'s files are candidates. A marker probe failing
 * for any reason but absence throws, as the Harness does.
 */
export function instructionChain(cwd: string): InstructionFile[] {
  const files: InstructionFile[] = []
  const seen = new Set<string>()
  const add = (path: string, scope: MemoryScope): void => {
    if (seen.has(path)) return
    seen.add(path)
    files.push({ path, scope, exists: isFile(path) })
  }
  add(join(dshHome(), 'AGENTS.md'), 'global')
  const target = resolve(cwd)
  const root = projectRoot(target)
  const dirs: string[] = []
  let current = target
  while (current !== root) {
    dirs.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  dirs.push(root)
  for (const dir of dirs.toReversed()) {
    for (const name of [...BASE_CANDIDATES, ...LOCAL_CANDIDATES]) add(join(dir, name), 'project')
  }
  return files
}

/**
 * Append one line to an instruction file, creating it (and its directory)
 * when missing. The line is collapsed to a single line; the file always ends
 * with a newline afterwards, and an existing file's mode is kept.
 * @throws on an empty line or I/O failure.
 */
export function appendInstruction(path: string, line: string): void {
  const text = oneLine(line)
  if (text === '') throw new Error('nothing to append')
  const existing = readIfPresent(path) ?? ''
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
  let mode = 0o600
  try {
    mode = statSync(path).mode & 0o777
  } catch {
    // New file: the default mode applies.
  }
  writeAtomic(path, `${existing}${separator}${text}\n`, mode)
}

// ------------------------------------------------------------- quick notes

/**
 * The note in a `# ` quick-add, or undefined when `text` is a normal prompt.
 *
 * Exactly one line that starts with `# ` and has something after it. A
 * multi-line paste that happens to open with a markdown heading, a bare `#`,
 * or `#tag` are prompts like any other.
 */
export function quickNote(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed.includes('\n') || !trimmed.startsWith('# ')) return undefined
  const note = trimmed.slice(2).trim()
  return note === '' ? undefined : note
}

/** A title for a note: its first words, cut at a word boundary near 60 characters. */
function noteTitle(note: string): string {
  const line = oneLine(note)
  if (line.length <= 60) return line
  const cut = line.lastIndexOf(' ', 60)
  return `${line.slice(0, cut > 20 ? cut : 60)}…`
}

// ------------------------------------------------------------- MemoryStore

/** A memory as the store hands it out: with the file it lives in, for `$EDITOR`. */
export interface StoredMemory extends Memory {
  path: string
}

/**
 * Memory and instructions as one session sees them. This is the interface
 * callers use — the memory tools, the `/memory` panel, the prompt section, the
 * `# ` quick-add; the functions above are its implementation.
 *
 * Bound to the session's directory once, so no caller passes `cwd` again or
 * learns where anything lives: every memory comes back with its `path`, and
 * {@link indexFile} names the index to open.
 */
export class MemoryStore {
  /** The directory the session works in; picks the project scope. */
  readonly cwd: string

  constructor(cwd: string) {
    this.cwd = cwd
  }

  /** Create or replace a memory; see {@link save}. */
  save(scope: MemoryScope, input: MemoryInput): StoredMemory {
    return this.located(save(scope, this.cwd, input))
  }

  /** One memory by title or slug, or undefined. */
  read(scope: MemoryScope, name: string): StoredMemory | undefined {
    const memory = read(scope, this.cwd, name)
    return memory === undefined ? undefined : this.located(memory)
  }

  /** Remove a memory and its index line; false when there was none. */
  forget(scope: MemoryScope, name: string): boolean {
    return forget(scope, this.cwd, name)
  }

  /** Every memory in a scope, in index order. */
  list(scope: MemoryScope): StoredMemory[] {
    return list(scope, this.cwd).map((memory) => this.located(memory))
  }

  /** The index text for the `moqi:memory` prompt section; '' when there is no memory. */
  promptIndex(budget?: IndexBudget): string {
    return renderIndexForPrompt(this.cwd, budget)
  }

  /** The instruction files the Harness loads here, including ones not yet created. */
  instructions(): InstructionFile[] {
    return instructionChain(this.cwd)
  }

  /**
   * Keep a `# ` quick-add note as a memory of its own. The note is the body
   * and the description; its first words are the title. A note whose title
   * collides with an existing memory gets a numbered name instead — a quick
   * note never silently replaces something saved earlier.
   */
  saveNote(scope: MemoryScope, note: string): StoredMemory {
    const base = noteTitle(note)
    let title = base
    let n = 2
    while (this.read(scope, title) !== undefined) {
      title = `${base} ${String(n)}`
      n += 1
    }
    return this.save(scope, {
      name: title,
      description: oneLine(note),
      type: scope === 'project' ? 'project' : 'user',
      body: note,
    })
  }

  /**
   * Append a `# ` quick-add note as a bullet to the instruction file the
   * Harness reads for a scope: `$DSH_HOME/AGENTS.md`, or the project root's
   * `AGENTS.md`. Creates the file when missing.
   * @returns the file written.
   */
  addInstruction(scope: MemoryScope, note: string): string {
    const target = scope === 'global'
      ? join(dshHome(), 'AGENTS.md')
      : join(projectRoot(this.cwd), 'AGENTS.md')
    appendInstruction(target, `- ${note}`)
    return target
  }

  /** The `MEMORY.md` a scope's index lives in — what `/memory` opens in `$EDITOR`. */
  indexFile(scope: MemoryScope): string {
    return indexPath(scope, this.cwd)
  }

  private located(memory: Memory): StoredMemory {
    return { ...memory, path: memoryPath(memory.scope, this.cwd, memory.name) }
  }
}
