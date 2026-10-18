/**
 * Where the JSONL session store keeps sessions on disk, and how to remove one.
 *
 * The harness has no public delete API: storage is append-only by design and
 * the query index reconciles against the filesystem, dropping entries whose
 * session directory has gone. Deleting the directory is therefore the whole
 * operation — and the reason a session stays stored until the user asks.
 *
 * The path encoding here mirrors `dsh-session-persistence-jsonl` exactly:
 * `$DSH_HOME/sessions/<projectKey(cwd)>/<encodeSegment(id)>/`.
 * @module
 */
/**
 * `$DSH_HOME`, resolved exactly as the Harness does (`resolveDshHome` in
 * `dsh-home-paths`): unset, empty, or whitespace-only means `~/.dsh`. Every
 * moqi path under the Harness home goes through this one function, so moqi
 * never looks somewhere the Harness does not.
 */
export declare function dshHome(env?: NodeJS.ProcessEnv): string;
/** The sessions root: `$DSH_HOME/sessions`, defaulting to `~/.dsh/sessions`. */
export declare function sessionsRoot(): string;
/**
 * Encode one path segment: safe characters pass through, everything else
 * becomes `~XXXX` with the code unit in upper-case hex. `.`
 * and `..` are always escaped so a session id can never traverse.
 */
export declare function encodeSegment(raw: string): string;
/**
 * The readable directory key for a project path. Separators fold to `-`, the
 * result is bounded to a filesystem component, and the name always carries the
 * leading `--`/trailing `--` fence so a project directory is recognizable.
 */
export declare function projectKey(cwd: string): string;
/** The directory one stored session owns, given the cwd it was created with. */
export declare function storedSessionDir(cwd: string, id: string): string;
/**
 * Find a session's directory by id alone, scanning the project directories.
 *
 * The picker knows an id but not always the cwd it was created under, and the
 * encoded id segment is unique across projects, so a scan is both correct and
 * cheap: one `readdir` of the root plus one per project directory.
 */
export declare function findStoredSessionDir(id: string): Promise<string | undefined>;
/**
 * Delete a stored session from disk. The query index notices on its next
 * reconciliation pass, so the session disappears from `/resume` too.
 *
 * @returns `true` when something was removed, `false` when no such session
 *   was stored.
 */
export declare function deleteStoredSession(cwd: string, id: string): Promise<boolean>;
/** Delete a session found by id through {@link findStoredSessionDir}. */
export declare function deleteStoredSessionDir(dir: string): Promise<boolean>;
