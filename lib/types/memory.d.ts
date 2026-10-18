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
/** Where a memory lives: shared by every project, or tied to one. */
export type MemoryScope = 'global' | 'project';
/** What kind of fact a memory records. */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';
/** The memory types, in the order a picker should offer them. */
export declare const MEMORY_TYPES: readonly MemoryType[];
/** One stored memory. */
export interface Memory {
    /** The slug: file name without `.md`, and the key every call takes. */
    name: string;
    /** Human title, as written in front matter `name` and the index link. */
    title: string;
    /** One-line hook shown in the index. */
    description: string;
    type: MemoryType;
    body: string;
    scope: MemoryScope;
}
/** What a caller supplies to {@link save}. `name` is the title; its slug is the key. */
export interface MemoryInput {
    name: string;
    description: string;
    type: MemoryType;
    body: string;
}
/** One candidate instruction file the Harness would load if it exists. */
export interface InstructionFile {
    path: string;
    scope: MemoryScope;
    exists: boolean;
}
/** The directory one scope's memories live in. */
export declare function memoryDir(scope: MemoryScope, cwd: string): string;
/** The `MEMORY.md` index path for a scope — what `/memory` opens in `$EDITOR`. */
export declare function indexPath(scope: MemoryScope, cwd: string): string;
/** The file one memory lives in; `name` is slugified first. */
export declare function memoryPath(scope: MemoryScope, cwd: string, name: string): string;
/**
 * A lowercase kebab slug over `[a-z0-9-]`, at most 64 characters.
 *
 * Accents fold to their base letter; every other run of non-alphanumerics —
 * slashes, dots, spaces, CJK — becomes one dash. The alphabet alone makes a
 * path escape impossible; an input with nothing slug-worthy left throws
 * rather than inventing a name.
 */
export declare function slugify(input: string): string;
/**
 * Create or replace a memory. Saving a name whose slug already exists
 * replaces that memory and keeps its index line's position.
 * @returns the memory as stored.
 * @throws on an unusable name, an unknown type, an empty description, or I/O failure.
 */
export declare function save(scope: MemoryScope, cwd: string, input: MemoryInput): Memory;
/** One memory, or undefined when it does not exist. `name` may be a title or slug. */
export declare function read(scope: MemoryScope, cwd: string, name: string): Memory | undefined;
/**
 * Remove a memory's file and its index line.
 * @returns whether there was a memory file to remove.
 */
export declare function forget(scope: MemoryScope, cwd: string, name: string): boolean;
/**
 * Every memory in a scope, in index order; memories the index does not
 * mention follow alphabetically. A missing scope directory is an empty list.
 */
export declare function list(scope: MemoryScope, cwd: string): Memory[];
/** Budget for {@link renderIndexForPrompt}. */
export interface IndexBudget {
    maxLines?: number;
    maxBytes?: number;
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
export declare function renderIndexForPrompt(cwd: string, budget?: IndexBudget): string;
/**
 * The project root the Harness would pick: the nearest ancestor (or `cwd`
 * itself) holding a `.git` entry of any kind; with none, `cwd` itself.
 */
export declare function projectRoot(cwd: string): string;
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
export declare function instructionChain(cwd: string): InstructionFile[];
/**
 * Append one line to an instruction file, creating it (and its directory)
 * when missing. The line is collapsed to a single line; the file always ends
 * with a newline afterwards, and an existing file's mode is kept.
 * @throws on an empty line or I/O failure.
 */
export declare function appendInstruction(path: string, line: string): void;
/** A memory as the store hands it out: with the file it lives in, for `$EDITOR`. */
export interface StoredMemory extends Memory {
    path: string;
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
export declare class MemoryStore {
    /** The directory the session works in; picks the project scope. */
    readonly cwd: string;
    constructor(cwd: string);
    /** Create or replace a memory; see {@link save}. */
    save(scope: MemoryScope, input: MemoryInput): StoredMemory;
    /** One memory by title or slug, or undefined. */
    read(scope: MemoryScope, name: string): StoredMemory | undefined;
    /** Remove a memory and its index line; false when there was none. */
    forget(scope: MemoryScope, name: string): boolean;
    /** Every memory in a scope, in index order. */
    list(scope: MemoryScope): StoredMemory[];
    /** The index text for the `moqi:memory` prompt section; '' when there is no memory. */
    promptIndex(budget?: IndexBudget): string;
    /** The instruction files the Harness loads here, including ones not yet created. */
    instructions(): InstructionFile[];
    /** The `MEMORY.md` a scope's index lives in — what `/memory` opens in `$EDITOR`. */
    indexFile(scope: MemoryScope): string;
    private located;
}
