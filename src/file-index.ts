/**
 * A bounded, cached walk of the workspace for `@` file completion.
 *
 * The listing is refreshable rather than watched: completion is an
 * interactive nicety, so a few seconds of staleness after a checkout or a
 * build costs nothing, while a filesystem watcher would cost a handle and a
 * failure mode.
 * @module
 */

import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { SKIP_DIRECTORIES } from './tui/atfile.ts'

/** Hard ceiling on walked entries, so a giant monorepo cannot stall a keystroke. */
const MAX_ENTRIES = 4000
/** How deep the walk descends. */
const MAX_DEPTH = 8
/** Milliseconds a listing stays fresh. */
const FRESH_MS = 5000

/** Files ending here are never offered; nothing good comes of picking one. */
const SKIP_SUFFIXES = ['.lock', '.min.js', '.map']

export interface DirectoryListing {
  files: { path: string; directory: boolean }[]
}

/** One workspace's file list, recomputed lazily on demand. */
export class FileIndex {
  private readonly root: string
  private entries: string[] = []
  private readAt = 0
  private reading = false

  constructor(root: string) {
    this.root = root
  }

  /** Every workspace-relative file path, oldest acceptable snapshot or fresh. */
  list(): string[] {
    if (Date.now() - this.readAt > FRESH_MS && !this.reading) this.refresh()
    return this.entries
  }

  /** Synchronously rebuild the listing. Errors leave the previous snapshot. */
  refresh(): void {
    if (this.reading) return
    this.reading = true
    try {
      const found: string[] = []
      this.walk(this.root, 0, found)
      this.entries = found
      this.readAt = Date.now()
    } catch {
      // An unreadable workspace keeps the last good listing (or empty).
    } finally {
      this.reading = false
    }
  }

  private walk(directory: string, depth: number, found: string[]): void {
    if (depth >= MAX_DEPTH || found.length >= MAX_ENTRIES) return
    let names: string[]
    try {
      names = readdirSync(directory)
    } catch {
      return
    }
    for (const name of names) {
      if (found.length >= MAX_ENTRIES) return
      this.walkEntry(directory, name, depth, found)
    }
  }

  /** One directory entry: descend into it, or add the file under its root path. */
  private walkEntry(directory: string, name: string, depth: number, found: string[]): void {
    if (name.startsWith('.') && name !== '.github') return
    const full = join(directory, name)
    let stats
    try {
      stats = statSync(full)
    } catch {
      return
    }
    if (stats.isDirectory()) {
      if (SKIP_DIRECTORIES.has(name)) return
      this.walk(full, depth + 1, found)
      return
    }
    if (!stats.isFile()) return
    if (SKIP_SUFFIXES.some((suffix) => name.endsWith(suffix))) return
    const rel = relative(this.root, full)
    found.push(sep === '/' ? rel : rel.replaceAll(sep, '/'))
  }

  /**
   * List one directory for a path-shaped query, relative to the workspace
   * root. `.` and `..` are offered alongside the entries so navigation works
   * the way a shell expects.
   */
  listDir(relativePath: string): DirectoryListing {
    const base = relativePath === '' ? this.root : join(this.root, relativePath)
    let names: string[]
    try {
      names = readdirSync(base)
    } catch {
      return { files: [] }
    }
    const prefix = relativePath === '' ? '' : `${relativePath.replaceAll(sep, '/')}/`
    const files: { path: string; directory: boolean }[] = []
    for (const name of names.slice(0, MAX_ENTRIES)) {
      if (name.startsWith('.')) continue
      let stats
      try {
        stats = statSync(join(base, name))
      } catch {
        continue
      }
      files.push({ path: `${prefix}${name}`, directory: stats.isDirectory() })
    }
    files.sort((a, b) => Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path))
    return { files }
  }
}
