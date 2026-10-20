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
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dshHome, projectKey } from "./sessions-store.js";
const MODE_RANK = new Map([
    ['read-only', 0],
    ['workspace-write', 1],
    ['danger-full-access', 2],
]);
/**
 * Read an approval reason. The Harness phrases sandbox escalations as
 * `escalate sandbox to <mode>: <justification>` (`dsh-sandbox`, lib/index.js).
 * @returns the escalation, or `undefined` for a plain ask.
 */
export function parseEscalation(reason) {
    if (reason === undefined)
        return undefined;
    const found = /^escalate sandbox to ([^:\s]*)/.exec(reason);
    if (found === null)
        return undefined;
    const mode = found[1];
    return { mode: MODE_RANK.has(mode) ? mode : 'unknown' };
}
/** Whether a rule may answer an ask: plain asks always, escalations by mode. */
function grants(rule, escalation) {
    if (escalation === undefined)
        return true;
    const wanted = MODE_RANK.get(escalation.mode);
    const allowed = rule.mode === undefined ? undefined : MODE_RANK.get(rule.mode);
    return wanted !== undefined && allowed !== undefined && allowed >= wanted;
}
/** A rules file exists but could not be read as one. */
export class RulesFileError extends Error {
    path;
    constructor(path, message) {
        super(`${path}: ${message}`);
        this.name = 'RulesFileError';
        this.path = path;
    }
}
// ------------------------------------------------------------- shell tools
/**
 * Tool names whose argument is a shell command, as registered by the installed
 * Harness packages (`ctx.tools.register(defineTool({ name }))` in each
 * `lib/index.js`):
 * - `@deepseek-ai/dsh-tool-bash`, `@deepseek-ai/dsh-tool-bash-persistent` → `bash`
 * - `@deepseek-ai/dsh-tool-pwsh`, `@deepseek-ai/dsh-tool-pwsh-persistent` → `pwsh`
 * `@deepseek-ai/dsh-terminal-bash` registers a PTY backend, not a tool, so it
 * adds no name here.
 */
const SHELL_TOOLS = new Set(['bash', 'pwsh']);
/** Whether a tool's calls are matched by command pattern rather than by name. */
export function isShellTool(toolName) {
    return SHELL_TOOLS.has(toolName);
}
function dialectOf(toolName) {
    return toolName === 'pwsh' ? 'pwsh' : 'bash';
}
/**
 * Redirects that cannot write anywhere that matters: fd duplication (`2>&1`)
 * and discarding to `/dev/null` (or `$null` in PowerShell). Matched at a `>`;
 * the fd number before it is whatever token was being built.
 */
const SAFE_REDIRECT_BASH = /^(?:>&\d|>>?[ \t]*\/dev\/null)(?=$|[ \t\n;&|])/;
const SAFE_REDIRECT_PWSH = /^(?:>&\d|>>?[ \t]*(?:\/dev\/null|\$null))(?=$|[ \t\n;&|])/;
/**
 * Split a command into segments of tokens, or `undefined` when it contains
 * anything this module refuses to reason about. Empty segments (a trailing
 * `&` or `;`) are dropped.
 */
function lex(command, dialect) {
    return new Lexer(command, dialect).run();
}
/** Characters the lexer refuses anywhere outside single quotes. */
const REFUSED_CHARS = new Set(['<', '(', ')', '`']);
/** Characters that end a word, a segment, or start a redirect in the normal state. */
const OPERATOR_CHARS = new Set([' ', '\t', '\n', ';', '&', '|', '>']);
/** Backslash escapes that bash honors inside double quotes. */
const DOUBLE_QUOTE_ESCAPES = '$`"\\';
/** A control character other than tab and newline (C0 or DEL). */
function isControl(c) {
    const code = c.codePointAt(0);
    return (code < 0x20 && c !== '\t' && c !== '\n') || code === 0x7f;
}
/** `$(` or `${`: the start of a substitution. */
function isSubstitution(c, next) {
    return c === '$' && (next === '(' || next === '{');
}
/**
 * One pass of {@link lex}. Walks the command one UTF-16 unit at a time; each
 * `step…` method consumes what it reads and returns `false` to refuse the
 * whole command.
 */
class Lexer {
    command;
    dialect;
    segments = [];
    segment = [];
    text = '';
    plain = true;
    started = false;
    state = 'normal';
    i = 0;
    constructor(command, dialect) {
        this.command = command;
        this.dialect = dialect;
    }
    run() {
        // Refuse control characters up front, over the whole command, rather than
        // as each step begins: a step may consume more than one unit (a bash
        // backslash takes the character after it), and anything it swallows would
        // otherwise never be checked.
        for (const c of this.command) {
            if (isControl(c))
                return undefined;
        }
        while (this.i < this.command.length) {
            if (!this.step())
                return undefined;
        }
        if (this.state !== 'normal')
            return undefined;
        this.endSegment();
        return this.segments;
    }
    step() {
        if (this.state === 'single')
            return this.stepSingle();
        if (this.state === 'double')
            return this.stepDouble();
        return this.stepNormal();
    }
    stepSingle() {
        const c = this.command[this.i];
        if (c === "'")
            this.state = 'normal';
        else
            this.text += c;
        this.i += 1;
        return true;
    }
    stepDouble() {
        const c = this.command[this.i];
        const next = this.command[this.i + 1];
        if (c === '"') {
            this.state = 'normal';
            this.i += 1;
            return true;
        }
        if (c === '`' || isSubstitution(c, next))
            return false;
        if (c === '\\' && this.dialect === 'bash')
            return this.doubleQuotedEscape(next);
        this.text += c;
        this.i += 1;
        return true;
    }
    /** A bash backslash inside double quotes, at `this.i`. */
    doubleQuotedEscape(next) {
        if (next === undefined)
            return false;
        if (next === '\n') {
            this.i += 2; // line continuation
        }
        else if (DOUBLE_QUOTE_ESCAPES.includes(next)) {
            this.text += next;
            this.i += 2;
        }
        else {
            this.text += '\\';
            this.i += 1;
        }
        return true;
    }
    stepNormal() {
        const c = this.command[this.i];
        const next = this.command[this.i + 1];
        if (OPERATOR_CHARS.has(c))
            return this.operator(c, next);
        if (REFUSED_CHARS.has(c) || isSubstitution(c, next))
            return false;
        if (c === "'" || c === '"')
            return this.openQuote(c);
        if (c === '\\' && this.dialect === 'bash')
            return this.escape(next);
        this.text += c;
        this.started = true;
        this.i += 1;
        return true;
    }
    /** A separator, a segment boundary, or a redirect, at `this.i`. */
    operator(c, next) {
        switch (c) {
            case ' ':
            case '\t':
                this.endToken();
                this.i += 1;
                return true;
            case '\n':
            case ';':
                this.endSegment();
                this.i += 1;
                return true;
            case '&':
                return this.ampersand(next);
            case '|':
                this.endSegment();
                this.i += next === '|' ? 2 : 1;
                return true;
            default: // '>'
                return this.redirect();
        }
    }
    ampersand(next) {
        if (next === '>')
            return this.bothStreamsRedirect();
        this.endSegment();
        this.i += next === '&' ? 2 : 1;
        return true;
    }
    /** `&>` redirects both streams: only harmless when to /dev/null. */
    bothStreamsRedirect() {
        if (this.started)
            return false;
        const span = this.safeRedirect(this.i + 1);
        if (span === 0 || this.command[this.i + 2] === '&')
            return false;
        this.endToken();
        this.i += 1 + span;
        return true;
    }
    /** `>`: only an fd number (or nothing) may precede a redirect operator. */
    redirect() {
        if (this.started && !(this.plain && /^\d+$/.test(this.text)))
            return false;
        const span = this.safeRedirect(this.i);
        if (span === 0)
            return false;
        this.resetToken();
        this.i += span;
        return true;
    }
    openQuote(c) {
        this.state = c === "'" ? 'single' : 'double';
        this.plain = false;
        this.started = true;
        this.i += 1;
        return true;
    }
    /** A bash backslash outside quotes, at `this.i`. */
    escape(next) {
        if (next === undefined)
            return false;
        if (next !== '\n') {
            this.text += next;
            this.plain = false;
            this.started = true;
        } // else: line continuation, nothing to add
        this.i += 2;
        return true;
    }
    /** The length of a safe redirect starting at `at`, or 0 when it is not one. */
    safeRedirect(at) {
        const re = this.dialect === 'pwsh' ? SAFE_REDIRECT_PWSH : SAFE_REDIRECT_BASH;
        const found = re.exec(this.command.slice(at));
        return found === null ? 0 : found[0].length;
    }
    resetToken() {
        this.text = '';
        this.plain = true;
        this.started = false;
    }
    endToken() {
        if (this.started)
            this.segment.push({ text: this.text, plain: this.plain });
        this.resetToken();
    }
    endSegment() {
        this.endToken();
        if (this.segment.length > 0)
            this.segments.push(this.segment);
        this.segment = [];
    }
}
/** Parse a rule's command pattern, or explain why it is not one. */
function parsePattern(source) {
    const segments = lex(source, 'bash');
    if (segments === undefined)
        return 'pattern contains quoting or operators moqi refuses';
    if (segments.length !== 1)
        return 'pattern must be a single command (no ;, &&, ||, | or &)';
    const tokens = segments[0];
    const last = tokens.at(-1);
    const wildcard = last.plain && last.text === '*';
    const fixed = wildcard ? tokens.slice(0, -1) : tokens;
    if (fixed.some((t) => t.plain && t.text === '*'))
        return '`*` is only allowed as the last word';
    return { tokens: fixed.map((t) => t.text), wildcard };
}
/** Quote one word so the pattern lexer reads it back as the same text. */
function quoteWord(word) {
    if (/^[A-Za-z0-9_./:@%+=,~^-]+$/.test(word))
        return word;
    const escaped = word.replaceAll("'", String.raw `'\''`);
    return `'${escaped}'`;
}
function renderPattern(pattern) {
    const words = pattern.tokens.map(quoteWord);
    if (pattern.wildcard)
        words.push('*');
    return words.join(' ');
}
function patternMatches(pattern, words) {
    if (pattern.wildcard ? words.length < pattern.tokens.length : words.length !== pattern.tokens.length) {
        return false;
    }
    return pattern.tokens.every((token, index) => words[index] === token);
}
// ------------------------------------------------------------------- rules
/**
 * Validate and canonicalize a rule: a non-empty tool name without whitespace
 * or control characters, and — when present — a well-formed command pattern,
 * re-rendered so `git  log *` and `git log *` are the same rule.
 * @throws Error when the rule is not well-formed.
 */
export function normalizeRule(rule) {
    const tool = rule.tool;
    // `\s` already covers \t \n \v \f \r (0x09–0x0d); the ranges add the rest of C0 and DEL.
    if (typeof tool !== 'string' || !/^[^\s\x00-\x08\x0e-\x1f\x7f]+$/.test(tool)) {
        throw new Error(`invalid tool name ${JSON.stringify(tool)}`);
    }
    const out = { tool };
    if (rule.command !== undefined) {
        if (typeof rule.command !== 'string')
            throw new Error('command must be a string');
        const parsed = parsePattern(rule.command);
        if (typeof parsed === 'string')
            throw new Error(`invalid command ${JSON.stringify(rule.command)}: ${parsed}`);
        out.command = renderPattern(parsed);
    }
    if (rule.mode !== undefined) {
        if (!(typeof rule.mode === 'string' && MODE_RANK.has(rule.mode))) {
            throw new Error(`invalid mode ${JSON.stringify(rule.mode)}`);
        }
        out.mode = rule.mode;
    }
    return out;
}
/** Whether two rules are the same once normalized (tool, command and mode). */
export function sameRule(a, b) {
    return a.tool === b.tool && a.command === b.command && a.mode === b.mode;
}
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
export function suggestPattern(toolName, command, reason) {
    const escalation = parseEscalation(reason);
    if (escalation?.mode === 'unknown')
        return undefined;
    const withMode = (rule) => (escalation === undefined ? rule : { ...rule, mode: escalation.mode });
    if (!isShellTool(toolName))
        return withMode({ tool: toolName });
    if (command === undefined)
        return undefined;
    const segments = lex(command, dialectOf(toolName));
    if (segments?.length !== 1)
        return undefined;
    const words = segments[0].map((t) => t.text);
    const second = words[1];
    const narrow = second !== undefined && !second.startsWith('-') && !second.includes('/') && !/^[.~]/.test(second);
    const tokens = narrow ? words.slice(0, 2) : words.slice(0, 1);
    return withMode({ tool: toolName, command: renderPattern({ tokens, wildcard: true }) });
}
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
export function matches(rules, toolName, command, escalation) {
    const eligible = rules.filter((r) => r.tool === toolName && grants(r, escalation));
    if (!isShellTool(toolName))
        return eligible.find((r) => r.command === undefined);
    if (command === undefined)
        return undefined;
    const segments = lex(command, dialectOf(toolName));
    if (segments === undefined || segments.length === 0)
        return undefined;
    const candidates = [];
    for (const rule of eligible) {
        if (rule.command === undefined)
            continue;
        const pattern = parsePattern(rule.command);
        if (typeof pattern !== 'string')
            candidates.push({ rule, pattern });
    }
    let first;
    for (const segment of segments) {
        const words = segment.map((t) => t.text);
        const hit = candidates.find((c) => patternMatches(c.pattern, words));
        if (hit === undefined)
            return undefined;
        first ??= hit.rule;
    }
    return first;
}
// ------------------------------------------------------------- file format
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
export function formatRules(rules) {
    if (rules.length === 0)
        return 'version: 1\nallow: []\n';
    const lines = ['version: 1', 'allow:'];
    for (const rule of rules) {
        lines.push(`  - tool: ${yamlScalar(rule.tool)}`);
        if (rule.command !== undefined)
            lines.push(`    command: ${yamlScalar(rule.command)}`);
        if (rule.mode !== undefined)
            lines.push(`    mode: ${yamlScalar(rule.mode)}`);
    }
    return `${lines.join('\n')}\n`;
}
/** Plain scalars: start with a word character or `.`/`/`, no `: ` or ` #`, no trailing space. */
const PLAIN_SCALAR = /^[A-Za-z0-9_./][A-Za-z0-9_./ *@%+=,~^:-]*$/;
function isPlainSafe(value) {
    return PLAIN_SCALAR.test(value) && !value.endsWith(' ') && !value.endsWith(':') && !value.includes(': ')
        && !/^(?:true|false|null|yes|no|on|off|~)$/i.test(value) && !/^[-+.\d]/.test(value.replace(/^\.\//, 'x'));
}
function yamlScalar(value) {
    return isPlainSafe(value) ? value : JSON.stringify(value);
}
/** Read one scalar value; throws on anything outside the subset. */
function parseScalar(raw, line) {
    const value = raw.trim();
    if (value.startsWith('"'))
        return parseDoubleQuoted(value, line);
    if (value.startsWith("'"))
        return parseSingleQuoted(value, line);
    return parsePlain(value, line);
}
function parseDoubleQuoted(value, line) {
    const end = closingDoubleQuote(value);
    if (end === -1)
        throw new Error(`line ${line}: unterminated double-quoted value`);
    if (!isCommentOrEmpty(value.slice(end + 1)))
        throw new Error(`line ${line}: unexpected text after quoted value`);
    try {
        return JSON.parse(value.slice(0, end + 1));
    }
    catch {
        throw new Error(`line ${line}: unsupported escape in double-quoted value`);
    }
}
/** A `'…'` scalar, where `''` stands for one quote. */
function parseSingleQuoted(value, line) {
    let out = '';
    let i = 1;
    while (i < value.length) {
        if (value[i] !== "'") {
            out += value[i];
            i += 1;
        }
        else if (value[i + 1] === "'") {
            out += "'";
            i += 2;
        }
        else {
            if (!isCommentOrEmpty(value.slice(i + 1)))
                throw new Error(`line ${line}: unexpected text after quoted value`);
            return out;
        }
    }
    throw new Error(`line ${line}: unterminated single-quoted value`);
}
function parsePlain(value, line) {
    const plain = stripComment(value);
    if (plain.length === 0)
        throw new Error(`line ${line}: empty value`);
    if (!PLAIN_SCALAR.test(plain) || plain.includes(': ')) {
        throw new Error(`line ${line}: value ${JSON.stringify(plain)} must be quoted`);
    }
    return plain;
}
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;
/**
 * Drop a trailing ` # comment`: the first `#` preceded by whitespace, together
 * with that whitespace run and the rest of the text. Same result as
 * `text.replace(/\s+#.*$/, '')` without its backtracking: as there, `.` stops
 * at line terminators, so a `#` with one after it does not start a comment.
 */
function stripComment(text) {
    let lastTerminator = -1;
    for (let i = text.length - 1; i >= 0; i -= 1) {
        if (LINE_TERMINATOR.test(text[i])) {
            lastTerminator = i;
            break;
        }
    }
    for (let hash = text.indexOf('#', lastTerminator + 1); hash !== -1; hash = text.indexOf('#', hash + 1)) {
        if (hash === 0 || !/\s/.test(text[hash - 1]))
            continue;
        let start = hash - 1;
        while (start > 0 && /\s/.test(text[start - 1]))
            start -= 1;
        return text.slice(0, start);
    }
    return text;
}
function closingDoubleQuote(value) {
    for (let i = 1; i < value.length; i += 1) {
        if (value[i] === '\\')
            i += 1;
        else if (value[i] === '"')
            return i;
    }
    return -1;
}
function isCommentOrEmpty(rest) {
    return /^\s*(?:#.*)?$/.test(rest);
}
/**
 * Parse a rules file written by {@link formatRules} or by hand in the same
 * subset: `version: 1`, then `allow:` with `[]` or a list of `- tool: X`
 * items each optionally carrying `command: Y` and `mode: Z`. Blank lines and full-line `#`
 * comments are allowed. Every rule is validated with {@link normalizeRule}.
 * An empty file is an empty rule list.
 * @throws Error naming the offending line for anything else.
 */
export function parseRules(text) {
    const parser = new RulesParser();
    const lines = text.replace(/^﻿/, '').split(/\r?\n/);
    lines.forEach((line, index) => parser.line(line, index + 1));
    return parser.finish();
}
/** The line-by-line state of {@link parseRules}. Every method throws on bad input. */
class RulesParser {
    version;
    inAllow = false;
    allowSeen = false;
    rules = [];
    item;
    line(line, lineNo) {
        if (/^\s*(?:#.*)?$/.test(line))
            return;
        if (line.includes('\t'))
            throw new Error(`line ${lineNo}: tabs are not allowed`);
        const top = /^([A-Za-z_]+):(.*)$/.exec(line);
        if (top === null)
            this.allowLine(line, lineNo);
        else
            this.topLine(top[1], top[2], lineNo);
    }
    finish() {
        this.flush();
        if (this.rules.length > 0 || this.allowSeen || this.version !== undefined) {
            if (this.version === undefined)
                throw new Error('missing "version: 1"');
            if (!this.allowSeen)
                throw new Error('missing "allow"');
        }
        return this.rules;
    }
    /** `version:` or `allow:` at column 0. */
    topLine(key, rest, lineNo) {
        this.flush();
        this.inAllow = false;
        if (key === 'version')
            this.versionLine(rest, lineNo);
        else if (key === 'allow')
            this.allowHeader(rest, lineNo);
        else
            throw new Error(`line ${lineNo}: unknown key "${key}"`);
    }
    versionLine(rest, lineNo) {
        if (this.version !== undefined)
            throw new Error(`line ${lineNo}: duplicate "version"`);
        this.version = parseScalar(rest, lineNo);
        if (this.version !== '1')
            throw new Error(`line ${lineNo}: unsupported version ${JSON.stringify(this.version)}`);
    }
    allowHeader(rest, lineNo) {
        if (this.allowSeen)
            throw new Error(`line ${lineNo}: duplicate "allow"`);
        this.allowSeen = true;
        const value = stripComment(rest).trim();
        if (value === '[]')
            return;
        if (value !== '')
            throw new Error(`line ${lineNo}: "allow" must be a list`);
        this.inAllow = true;
    }
    /** An indented line: a `- key: value` item start, or a further field of the current item. */
    allowLine(line, lineNo) {
        if (!this.inAllow)
            throw new Error(`line ${lineNo}: unexpected indented line`);
        const listItem = /^(\s*)- ([A-Za-z_]+):(?: (.*))?$/.exec(line);
        if (listItem !== null) {
            this.flush();
            this.item = { indent: listItem[1].length, line: lineNo };
            this.setKey(listItem[2], listItem[3] ?? '', lineNo);
            return;
        }
        const field = /^(\s+)([A-Za-z_]+):(?: (.*))?$/.exec(line);
        if (field !== null && this.item !== undefined && field[1].length === this.item.indent + 2) {
            this.setKey(field[2], field[3] ?? '', lineNo);
            return;
        }
        throw new Error(`line ${lineNo}: not a rule line`);
    }
    setKey(key, raw, line) {
        const item = this.item;
        if (item === undefined)
            throw new Error(`line ${line}: "${key}" outside a list item`);
        if (key !== 'tool' && key !== 'command' && key !== 'mode')
            throw new Error(`line ${line}: unknown key "${key}"`);
        if (item[key] !== undefined)
            throw new Error(`line ${line}: duplicate key "${key}"`);
        item[key] = parseScalar(raw, line);
    }
    /** Close the current item, validating it as a rule. */
    flush() {
        const item = this.item;
        if (item === undefined)
            return;
        if (item.tool === undefined)
            throw new Error(`line ${item.line}: rule has no tool`);
        try {
            const rule = { tool: item.tool };
            if (item.command !== undefined)
                rule.command = item.command;
            if (item.mode !== undefined)
                rule.mode = item.mode; // validated below
            this.rules.push(normalizeRule(rule));
        }
        catch (error) {
            throw new Error(`line ${item.line}: ${error.message}`);
        }
        this.item = undefined;
    }
}
// ------------------------------------------------------------------- store
/** `$DSH_HOME/moqi/permissions`, defaulting to `~/.dsh/moqi/permissions`. */
export function permissionsDir() {
    return join(dshHome(), 'moqi', 'permissions');
}
/** The file a scope's rules live in. `cwd` only matters for `project`. */
export function rulesPath(scope, cwd) {
    return join(permissionsDir(), scope === 'global' ? 'global.yaml' : `${projectKey(cwd)}.yaml`);
}
/**
 * Load one scope's rules. A missing file is no rules.
 * @throws RulesFileError when the file exists but is malformed or unreadable.
 */
export async function loadRules(scope, cwd) {
    const path = rulesPath(scope, cwd);
    let text;
    try {
        text = await readFile(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw new RulesFileError(path, error.message);
    }
    try {
        return parseRules(text);
    }
    catch (error) {
        throw new RulesFileError(path, error.message);
    }
}
/**
 * Every rule that applies in `cwd`: the caller's session rules, then project,
 * then global, each tagged with its scope. A malformed file contributes no
 * rules (fail closed) and is reported in `errors` instead of throwing, so one
 * bad file never takes the others down with it.
 */
export async function loadAllRules(cwd, sessionRules = []) {
    const rules = sessionRules.map((r) => ({ ...r, scope: 'session' }));
    const errors = [];
    // The two reads are independent; read them together, then merge in scope order.
    const scopes = ['project', 'global'];
    const loaded = await Promise.all(scopes.map((scope) => loadRules(scope, cwd).then((scopeRules) => ({ scope, ok: true, scopeRules, error: undefined }), (error) => ({ scope, ok: false, scopeRules: [], error }))));
    for (const { scope, ok, scopeRules, error } of loaded) {
        if (ok) {
            for (const rule of scopeRules)
                rules.push({ ...rule, scope });
        }
        else if (error instanceof RulesFileError) {
            errors.push(error);
        }
        else {
            throw error;
        }
    }
    return { rules, errors };
}
/**
 * Add a rule to a file scope, normalized. Rules differing only in `mode` are
 * distinct entries. A malformed existing file is left
 * untouched and the error thrown, never overwritten.
 * @returns `false` when an equal rule was already there.
 */
export async function addRule(scope, cwd, rule) {
    const normalized = normalizeRule(rule);
    const rules = await loadRules(scope, cwd);
    if (rules.some((r) => sameRule(r, normalized)))
        return false;
    await writeRules(rulesPath(scope, cwd), [...rules, normalized]);
    return true;
}
/**
 * Remove a rule from a file scope.
 * @returns `false` when no equal rule was there.
 */
export async function removeRule(scope, cwd, rule) {
    const normalized = normalizeRule(rule);
    const rules = await loadRules(scope, cwd);
    const kept = rules.filter((r) => !sameRule(r, normalized));
    if (kept.length === rules.length)
        return false;
    await writeRules(rulesPath(scope, cwd), kept);
    return true;
}
/** Write-then-rename, mode 0600, creating the directory (0700) as needed. */
async function writeRules(path, rules) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const scratch = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(scratch, formatRules(rules), { mode: 0o600 });
        await rename(scratch, path);
    }
    catch (error) {
        await rm(scratch, { force: true });
        throw error;
    }
}
/**
 * A rule as people read it: `bash(git log *)`, `read`, `bash(git fetch *) @ danger-full-access`.
 */
export function describeRule(rule) {
    const head = rule.command === undefined ? rule.tool : `${rule.tool}(${rule.command})`;
    return rule.mode === undefined ? head : `${head} @ ${rule.mode}`;
}
/**
 * The exact arguments of one tool call, read from the session log: the
 * `tool/call` event with `callId`, or — for a call nested inside `run_code` —
 * the `tool/ptc-dispatch-start` whose `subCallId` it is. The Harness appends
 * both before any approval is asked, so searching from the newest event finds
 * them at once. Undefined when absent, which makes every shell rule miss.
 */
export function callArguments(events, callId) {
    if (callId === undefined)
        return undefined;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const { type, data } = events[index];
        const record = data;
        if (record === null || typeof record !== 'object')
            continue;
        if (type === 'tool/call' && record['callId'] === callId)
            return record['arguments'];
        if (type === 'tool/ptc-dispatch-start' && record['subCallId'] === callId)
            return record['arguments'];
    }
    return undefined;
}
/**
 * The shell command a call runs, read from its arguments. Shell tools take
 * it as `command` (`dsh-tool-bash`, `dsh-tool-pwsh`). Anything unreadable is
 * `undefined`, which never matches a shell rule.
 */
function commandOf(ask) {
    if (!isShellTool(ask.toolName))
        return undefined;
    let args = ask.args;
    if (typeof args === 'string') {
        try {
            args = JSON.parse(args);
        }
        catch {
            return undefined;
        }
    }
    if (typeof args !== 'object' || args === null)
        return undefined;
    const command = args['command'];
    return typeof command === 'string' ? command : undefined;
}
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
export class PermissionRules {
    /** The directory the session works in; picks the project rules file. */
    cwd;
    sessionRules = [];
    constructor(cwd) {
        this.cwd = cwd;
    }
    /** The rule that allows this call without asking, or undefined to ask. */
    async decide(ask) {
        const { rules } = await loadAllRules(this.cwd, this.sessionRules);
        const escalation = parseEscalation(ask.reason);
        if (escalation?.mode === 'unknown')
            return undefined;
        return matches(rules, ask.toolName, commandOf(ask), escalation);
    }
    /** The "always allow" rule the panel should offer for this call, or undefined to offer none. */
    suggest(ask) {
        return suggestPattern(ask.toolName, commandOf(ask), ask.reason);
    }
    /** The exact shell command a call runs, for the panel to show; undefined for other tools. */
    command(ask) {
        return commandOf(ask);
    }
    /**
     * Allow a rule in a scope, normalized. `session` lasts as long as this
     * object; the others are written to their file.
     * @returns false when an equal rule was already there.
     * @throws when the rule is malformed, or its file is and so cannot be safely rewritten.
     */
    async grant(rule, scope) {
        if (scope !== 'session')
            return await addRule(scope, this.cwd, rule);
        const normalized = normalizeRule(rule);
        if (this.sessionRules.some((r) => sameRule(r, normalized)))
            return false;
        this.sessionRules.push(normalized);
        return true;
    }
    /** Remove a rule from a scope. @returns false when no equal rule was there. */
    async revoke(rule, scope) {
        if (scope !== 'session')
            return await removeRule(scope, this.cwd, rule);
        const normalized = normalizeRule(rule);
        const kept = this.sessionRules.filter((r) => !sameRule(r, normalized));
        if (kept.length === this.sessionRules.length)
            return false;
        this.sessionRules = kept;
        return true;
    }
    /** The file a scope's rules are kept in — what `/permissions` opens in `$EDITOR`. */
    file(scope) {
        return rulesPath(scope, this.cwd);
    }
    /** Every rule in force here, scope-tagged, plus any rules file that could not be read. */
    async list() {
        const { rules, errors } = await loadAllRules(this.cwd, this.sessionRules);
        return { rules, errors: errors.map((error) => error.message) };
    }
}
