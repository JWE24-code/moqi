/**
 * Trust-surface panels: tool approval, `ask_user_question`, plan review, and a
 * running sign-in.
 *
 * These are the moments something stops and asks a human — the agent, or a
 * `ctx.authorization` flow doing its own OAuth dance — so they own the
 * keyboard while open and answer through the Harness's own seams. Like the
 * rest of `tui/`, this module is pure state plus a view shape — the app layer
 * does the Cordis wiring and the renderer does the drawing.
 * @module
 */
import { t } from "./i18n.js";
/**
 * Read a spoken (transcribed) answer as an approval decision.
 *
 * Deliberately narrow: a misheard sentence must never grant a tool call, so
 * only unambiguous words decide and anything else returns `undefined`, leaving
 * the panel waiting. Both shipped interface languages are accepted.
 */
export function interpretApproval(text) {
    const words = text
        .toLowerCase()
        .replace(/[.,!?;:，。！？；：]/g, ' ')
        .split(/\s+/)
        .filter((word) => word !== '');
    const yes = new Set(['allow', 'allowed', 'yes', 'yeah', 'ok', 'okay', 'approve', 'approved', 'go', 'run', '允许', '同意', '可以', '好的', '好', '是', '行']);
    const no = new Set(['deny', 'denied', 'no', 'nope', 'reject', 'rejected', 'stop', 'cancel', '拒绝', '不行', '不要', '不', '取消', '否']);
    // A denial wins when both appear ("no, don't allow it"): the safe reading of
    // an ambiguous sentence is the one that does not run a tool.
    if (words.some((word) => no.has(word)))
        return 'rejected';
    if (words.some((word) => yes.has(word)))
        return 'allowed-once';
    return undefined;
}
/**
 * One pending tool approval.
 *
 * There is no persistent grant in the protocol — "allow once" or deny — so the
 * panel offers exactly those two rows and no "always" temptation.
 */
export class ApprovalPanel {
    selected = 0;
    toolName;
    reason;
    command;
    constructor(toolName, reason, command) {
        this.toolName = toolName;
        this.reason = reason;
        this.command = command;
    }
    move(delta) {
        this.selected = this.selected + delta < 0 ? 0 : Math.min(this.selected + delta, 1);
    }
    decision() {
        return this.selected === 0 ? 'allowed-once' : 'rejected';
    }
    view() {
        const detail = [this.reason ?? '', this.command === undefined ? '' : `\`\`\`sh\n${this.command}\n\`\`\``]
            .filter((part) => part !== '')
            .join('\n\n');
        return {
            kind: 'approval',
            title: t('approval.title', { tool: this.toolName }),
            detail,
            rows: [
                { label: t('approval.allow'), description: t('approval.allowDetail'), selected: this.selected === 0 },
                { label: t('approval.deny'), description: t('approval.denyDetail'), selected: this.selected === 1 },
            ],
            hint: t('approval.hint'),
        };
    }
}
/** Raised when the user backs out of a question set; the service maps it to `ASK_CANCELLED`. */
export const ASK_CANCELLED_CODE = 'ASK_CANCELLED';
/**
 * The `ask_user_question` flow, question by question.
 *
 * Single-select answers on `enter`; multi-select toggles with `space` and
 * collects with `enter`; `tab` moves to the free-text line, and typing on an
 * option row combines that option's label with the text, the way a form does.
 * A plan review is the same shape with a markdown body and an approve label
 * named by the protocol — approval never carries feedback, because the
 * protocol reads feedback as "keep planning".
 */
export class QuestionsPanel {
    index = 0;
    focus = 'options';
    drafts = new Map();
    questions;
    constructor(questions) {
        this.questions = questions;
        for (const question of questions) {
            this.drafts.set(question.id, { selected: [], custom: '', cursor: 0 });
        }
    }
    get question() {
        return this.questions[this.index];
    }
    get draft() {
        const question = this.question;
        if (question === undefined)
            return { selected: [], custom: '', cursor: 0 };
        let draft = this.drafts.get(question.id);
        if (draft === undefined) {
            draft = { selected: [], custom: '', cursor: 0 };
            this.drafts.set(question.id, draft);
        }
        return draft;
    }
    /** Whether this set is a plan under review rather than a question. */
    get isPlanReview() {
        return this.question?.intent?.kind === 'plan-review';
    }
    move(delta) {
        const options = this.question?.options ?? [];
        if (options.length === 0)
            return;
        this.focus = 'options';
        const next = this.draft.cursor + delta;
        this.draft.cursor = next < 0 ? 0 : Math.min(next, options.length - 1);
    }
    /** Space toggles the highlighted option on a multi-select question. */
    toggle() {
        const question = this.question;
        const options = question?.options ?? [];
        const option = options[this.draft.cursor];
        if (question === undefined || option === undefined)
            return;
        if (question.multiSelect !== true) {
            this.draft.selected = [option.label];
            return;
        }
        const at = this.draft.selected.indexOf(option.label);
        if (at === -1)
            this.draft.selected.push(option.label);
        else
            this.draft.selected.splice(at, 1);
    }
    focusCustom() {
        this.focus = 'custom';
    }
    /** Type into the free-text line; on an option row the option joins the answer. */
    typeText(chunk) {
        const question = this.question;
        const options = question?.options ?? [];
        const option = options[this.draft.cursor];
        if (this.focus === 'options' && option !== undefined && question?.multiSelect !== true) {
            this.draft.selected = [option.label];
        }
        this.focus = 'custom';
        this.draft.custom += chunk;
    }
    backspaceText() {
        this.focus = 'custom';
        this.draft.custom = this.draft.custom.slice(0, -1);
    }
    /**
     * Commit the current question and move on.
     *
     * @returns `'next'` when another question follows, `'done'` when the set is
     *   answered, and `'empty'` when nothing has been chosen yet.
     */
    advance() {
        const question = this.question;
        if (question === undefined)
            return 'done';
        const draft = this.draft;
        const hasAnswer = draft.selected.length > 0 || draft.custom.trim() !== '';
        if (!hasAnswer)
            return 'empty';
        if (this.index + 1 < this.questions.length) {
            this.index += 1;
            this.focus = 'options';
            return 'next';
        }
        return 'done';
    }
    /** Step back one question, keeping what was already chosen. */
    back() {
        if (this.index === 0)
            return false;
        this.index -= 1;
        this.focus = 'options';
        return true;
    }
    /** The finished answer set, in question order. */
    answers() {
        return this.questions.map((question) => {
            const draft = this.drafts.get(question.id) ?? { selected: [], custom: '', cursor: 0 };
            const custom = draft.custom.trim();
            const approve = question.intent?.kind === 'plan-review' && draft.selected[0] === question.intent.approve;
            return {
                id: question.id,
                selected: draft.selected,
                // Approval must not carry feedback: the protocol reads it as a
                // request to keep planning instead of a decision.
                custom: custom === '' || approve ? undefined : custom,
            };
        });
    }
    view() {
        const question = this.question;
        const options = question?.options ?? [];
        const draft = this.draft;
        const rows = options.map((option, index) => ({
            label: option.label,
            description: option.description,
            selected: this.focus === 'options' && index === draft.cursor,
            checked: question?.multiSelect === true ? draft.selected.includes(option.label) : undefined,
        }));
        const total = this.questions.length;
        const title = question?.header ??
            (total > 1
                ? t('questions.of', { n: this.index + 1, total })
                : t('questions.title'));
        const hint = this.isPlanReview
            ? t('questions.hintPlan')
            : question?.multiSelect === true
                ? t('questions.hintMulti')
                : t('questions.hint');
        return {
            kind: 'questions',
            title,
            detail: question?.detail === undefined ? (question?.question ?? '') : `${question.question}\n\n${question.detail}`,
            rows,
            hint: this.index === 0 ? `${hint}${t('questions.cancelSuffix')}` : hint,
            inputLabel: t('questions.answer'),
            inputText: draft.custom,
            inputFocused: this.focus === 'custom',
        };
    }
}
/**
 * One running `ctx.authorization` attempt, surfaced as a panel.
 *
 * Deliberately thin: this tracks only what is on screen — the last notice,
 * the live prompt if one is waiting, and what has been typed or highlighted
 * for it. Resolving a prompt is the caller's job, the same split
 * {@link ApprovalPanel} and {@link QuestionsPanel} keep, because answering one
 * is a call into the Harness and this module may depend on nothing from it.
 */
export class LoginPanel {
    label;
    notice;
    prompt;
    cursor = 0;
    draft = '';
    constructor(label) {
        this.label = label;
    }
    /**
     * Put a fresh prompt on screen, or clear it once it has been answered.
     * Starts from empty every time — a stale draft or highlight from the
     * question before it must never bleed into this one.
     */
    setPrompt(prompt) {
        this.prompt = prompt;
        this.draft = '';
        this.cursor = 0;
    }
    move(delta) {
        if (this.prompt?.kind !== 'select')
            return;
        const count = this.prompt.options.length;
        this.cursor = Math.max(Math.min(this.cursor + delta, count - 1), 0);
    }
    typeText(chunk) {
        if (this.prompt === undefined || this.prompt.kind === 'select')
            return;
        this.draft += chunk;
    }
    backspaceText() {
        if (this.prompt === undefined || this.prompt.kind === 'select')
            return;
        this.draft = this.draft.slice(0, -1);
    }
    /** What `enter` would answer the live prompt with, or undefined for none waiting. */
    answer() {
        const prompt = this.prompt;
        if (prompt === undefined)
            return undefined;
        return prompt.kind === 'select' ? prompt.options[this.cursor]?.id : this.draft;
    }
    view() {
        const notice = this.notice;
        const prompt = this.prompt;
        const rows = prompt?.kind === 'select'
            ? prompt.options.map((option, index) => ({
                label: option.label,
                description: option.description,
                selected: index === this.cursor,
            }))
            : [];
        const textPrompt = prompt?.kind === 'text' || prompt?.kind === 'secret';
        return {
            kind: 'login',
            title: `Sign in — ${this.label}`,
            detail: loginDetail(notice, prompt),
            rows,
            hint: loginHint(notice, prompt),
            inputLabel: textPrompt ? 'answer' : undefined,
            inputText: textPrompt && prompt !== undefined ? loginDraft(prompt, this.draft) : undefined,
            inputFocused: textPrompt,
        };
    }
}
/** The sign-in's body: what the flow reports, then what it asks. */
function loginDetail(notice, prompt) {
    const lines = [];
    // The url and code are what a device-code flow (GitHub Copilot's shape:
    // notify the page and the code, then prompt to confirm) still needs on
    // screen once its own prompt takes over — only the notice's plain message
    // is redundant then, since the prompt speaks for the moment now.
    if (notice !== undefined) {
        if (prompt === undefined)
            lines.push(notice.message);
        if (notice.url !== undefined)
            lines.push('', `Open: ${notice.url}`);
        if (notice.code !== undefined)
            lines.push('', `Code: \`${notice.code}\``);
    }
    if (prompt !== undefined) {
        if (lines.length > 0)
            lines.push('');
        lines.push(prompt.message);
    }
    return lines.join('\n');
}
/** The hint line: enter opens the page for the caller — this class stays free
 * of the Harness and npm alike, so it never spawns a browser itself. */
function loginHint(notice, prompt) {
    if (prompt === undefined) {
        return notice?.url === undefined
            ? 'esc cancels the sign-in'
            : 'enter opens the browser  ·  esc cancels the sign-in';
    }
    return prompt.kind === 'select'
        ? '↑↓ move  ·  enter choose  ·  esc decline'
        : 'enter submit  ·  esc decline';
}
/** What the masked or plain draft shows while a text prompt waits. */
function loginDraft(prompt, draft) {
    return prompt.kind === 'secret' ? '•'.repeat(draft.length) : draft;
}
