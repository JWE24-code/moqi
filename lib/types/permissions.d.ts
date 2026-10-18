/**
 * Permission rules: what moqi may auto-allow without opening the approval
 * panel, where those rules live, and — the security-sensitive part — whether a
 * tool call is covered by one.
 *
 * Three scopes. `session` rules are held in memory by the caller (the tab);
 * `project` and `global` rules are small YAML files under
 * `$DSH_HOME/moqi/permissions/`, keyed by {@link projectKey} so a cloned repo
 * can never ship its own grants.
 *
 * Matching errs on the side of NOT matching. A shell command is split into
 * segments on `&&`, `||`, `;`, `|`, `&` and newlines, and every segment must be
 * covered by a rule. Anything the lexer cannot reason about soundly — command
 * or process substitution, `${…}`, parentheses, backticks, any redirect other
 * than an fd duplication or `/dev/null`, input redirects and heredocs,
 * control characters, unbalanced quotes — makes the whole command unmatched,
 * so the panel opens as it always did.
 *
 * Callers use {@link PermissionRules} (at the end of this file): raw call
 * arguments in, a decision out. The functions before it are its
 * implementation, exported so this module's own tests can reach the lexer,
 * file format, and store directly.
 *
 * Node builtins only: the offline test suites load this module, so it must
 * never reach the Harness.
 * @module moqi-tui/permissions
 */
/** The Harness sandbox modes, narrowest first (`dsh-sandbox-policy`). */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
/**
 * One allow rule. A shell rule carries a command pattern; any other does not.
 * `mode` is the widest sandbox escalation the rule may grant; a rule without
 * one answers only plain asks, never an escalation.
 */
export interface Rule {
    tool: string;
    command?: string;
    mode?: SandboxMode;
}
/**
 * What an approval request asks for beyond running the tool: a sandbox
 * escalation to `mode`. `'unknown'` is an escalation whose mode this module
 * does not recognize — it never matches a rule.
 */
export interface Escalation {
    mode: SandboxMode | 'unknown';
}
/**
 * Read an approval reason. The Harness phrases sandbox escalations as
 * `escalate sandbox to <mode>: <justification>` (`dsh-sandbox`, lib/index.js).
 * @returns the escalation, or `undefined` for a plain ask.
 */
export declare function parseEscalation(reason: string | undefined): Escalation | undefined;
/** Where a rule lives. `session` rules are memory-only, held by the caller. */
export type Scope = 'session' | 'project' | 'global';
/** The scopes backed by a file. */
export type FileScope = 'project' | 'global';
/** A rule tagged with the scope it was loaded from. */
export interface ScopedRule extends Rule {
    scope: Scope;
}
/** A rules file exists but could not be read as one. */
export declare class RulesFileError extends Error {
    readonly path: string;
    constructor(path: string, message: string);
}
/** Whether a tool's calls are matched by command pattern rather than by name. */
export declare function isShellTool(toolName: string): boolean;
/**
 * Validate and canonicalize a rule: a non-empty tool name without whitespace
 * or control characters, and — when present — a well-formed command pattern,
 * re-rendered so `git  log *` and `git log *` are the same rule.
 * @throws Error when the rule is not well-formed.
 */
export declare function normalizeRule(rule: Rule): Rule;
/** Whether two rules are the same once normalized (tool, command and mode). */
export declare function sameRule(a: Rule, b: Rule): boolean;
/**
 * The default "always allow" rule for a call, as the approval panel offers it.
 *
 * Non-shell tools get a bare tool rule. A shell command gets its first two
 * words plus ` *` (`git log *`), or just the first word plus ` *` when the
 * second is a flag or a path (`ls -la` → `ls *`). When `reason` is a sandbox
 * escalation the rule records its mode. Returns `undefined` when no rule
 * could cover this call — a shell call with no recoverable command, one the
 * matcher refuses outright, a compound command, or an escalation to an
 * unknown mode — so the panel should not offer "always".
 */
export declare function suggestPattern(toolName: string, command: string | undefined, reason?: string): Rule | undefined;
/**
 * The first rule that allows this call, or `undefined`.
 *
 * `command` is the raw command string from the call's arguments (newlines and
 * all), never a display summary. Non-shell tools match a bare rule with the
 * same tool name. Shell tools need the command: every segment of it must
 * match some rule for that tool. An escalation ask (see
 * {@link parseEscalation}) only considers rules whose `mode` covers it; a
 * plain ask considers every rule. Rules whose pattern does not parse are
 * skipped, never treated as wildcards.
 */
export declare function matches<R extends Rule>(rules: readonly R[], toolName: string, command: string | undefined, escalation?: Escalation): R | undefined;
/**
 * Render a rules file. The format is a strict YAML subset:
 *
 * ```yaml
 * version: 1
 * allow:
 *   - tool: bash
 *     command: git log *
 *   - tool: read
 * ```
 *
 * Values are written plain when that is unambiguous YAML, double-quoted
 * (JSON escapes) otherwise.
 */
export declare function formatRules(rules: readonly Rule[]): string;
/**
 * Parse a rules file written by {@link formatRules} or by hand in the same
 * subset: `version: 1`, then `allow:` with `[]` or a list of `- tool: X`
 * items each optionally carrying `command: Y` and `mode: Z`. Blank lines and full-line `#`
 * comments are allowed. Every rule is validated with {@link normalizeRule}.
 * An empty file is an empty rule list.
 * @throws Error naming the offending line for anything else.
 */
export declare function parseRules(text: string): Rule[];
/** `$DSH_HOME/moqi/permissions`, defaulting to `~/.dsh/moqi/permissions`. */
export declare function permissionsDir(): string;
/** The file a scope's rules live in. `cwd` only matters for `project`. */
export declare function rulesPath(scope: FileScope, cwd: string): string;
/**
 * Load one scope's rules. A missing file is no rules.
 * @throws RulesFileError when the file exists but is malformed or unreadable.
 */
export declare function loadRules(scope: FileScope, cwd: string): Promise<Rule[]>;
/**
 * Every rule that applies in `cwd`: the caller's session rules, then project,
 * then global, each tagged with its scope. A malformed file contributes no
 * rules (fail closed) and is reported in `errors` instead of throwing, so one
 * bad file never takes the others down with it.
 */
export declare function loadAllRules(cwd: string, sessionRules?: readonly Rule[]): Promise<{
    rules: ScopedRule[];
    errors: RulesFileError[];
}>;
/**
 * Add a rule to a file scope, normalized. Rules differing only in `mode` are
 * distinct entries. A malformed existing file is left
 * untouched and the error thrown, never overwritten.
 * @returns `false` when an equal rule was already there.
 */
export declare function addRule(scope: FileScope, cwd: string, rule: Rule): Promise<boolean>;
/**
 * Remove a rule from a file scope.
 * @returns `false` when no equal rule was there.
 */
export declare function removeRule(scope: FileScope, cwd: string, rule: Rule): Promise<boolean>;
/**
 * One approval request, as the approval listener has it: the tool, the call's
 * raw arguments (the `tool/call` event's JSON string, or already parsed), and
 * the asker's reason. Never a display summary — see {@link matches}.
 */
export interface Ask {
    toolName: string;
    args?: unknown;
    reason?: string;
}
/**
 * A rule as people read it: `bash(git log *)`, `read`, `bash(git fetch *) @ danger-full-access`.
 */
export declare function describeRule(rule: Rule): string;
/**
 * The exact arguments of one tool call, read from the session log: the
 * `tool/call` event with `callId`, or — for a call nested inside `run_code` —
 * the `tool/ptc-dispatch-start` whose `subCallId` it is. The Harness appends
 * both before any approval is asked, so searching from the newest event finds
 * them at once. Undefined when absent, which makes every shell rule miss.
 */
export declare function callArguments(events: readonly {
    type: string;
    data: unknown;
}[], callId: string | undefined): unknown;
/**
 * The permission rules one session answers approvals with. This is the
 * interface callers use; the functions above are its implementation.
 *
 * It holds the session's own rules in memory and reads the project and global
 * files on every question — they are tiny, approvals are already async, and
 * it means a rule granted in another tab or edited by hand applies at once,
 * with no cache to go stale. A malformed file contributes nothing (fail
 * closed) and is reported by {@link list}.
 */
export declare class PermissionRules {
    /** The directory the session works in; picks the project rules file. */
    readonly cwd: string;
    private sessionRules;
    constructor(cwd: string);
    /** The rule that allows this call without asking, or undefined to ask. */
    decide(ask: Ask): Promise<ScopedRule | undefined>;
    /** The "always allow" rule the panel should offer for this call, or undefined to offer none. */
    suggest(ask: Ask): Rule | undefined;
    /** The exact shell command a call runs, for the panel to show; undefined for other tools. */
    command(ask: Ask): string | undefined;
    /**
     * Allow a rule in a scope, normalized. `session` lasts as long as this
     * object; the others are written to their file.
     * @returns false when an equal rule was already there.
     * @throws when the rule is malformed, or its file is and so cannot be safely rewritten.
     */
    grant(rule: Rule, scope: Scope): Promise<boolean>;
    /** Remove a rule from a scope. @returns false when no equal rule was there. */
    revoke(rule: Rule, scope: Scope): Promise<boolean>;
    /** Every rule in force here, scope-tagged, plus any rules file that could not be read. */
    list(): Promise<{
        rules: ScopedRule[];
        errors: string[];
    }>;
}
