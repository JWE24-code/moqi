/**
 * moqi — an interactive terminal app for DeepSeek Harness.
 *
 * The bundle patch rides over `dsh-base` without a Host, HTTP server, or
 * browser plugin: the terminal is the only surface. This module owns the
 * Harness wiring — creating or resuming an Agent, projecting its assistant
 * stream into the transcript, and dispatching slash commands through
 * `ctx.commands` — while `./tui/*` owns everything drawn on screen.
 *
 * @module moqi
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { brandString } from '@deepseek-ai/dsh-brand';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session';
import { AuthorizationDeclinedError, } from '@deepseek-ai/dsh-authorization';
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials';
import { Screen } from "./tui/screen.js";
import { Composer, InputHistory, Confirm, Palette, Picker, findTool, messageText, messageTools, moveSelection, ownerOfDelegated, queueShouldDrain, segmentTools, textMessage, } from "./tui/state.js";
import { AtMenu, activeAtToken, acceptToken, extractImageTokens, filterFiles, isImagePath, isPathShaped, } from "./tui/atfile.js";
import { FileIndex } from "./file-index.js";
import { TuiHost } from "./tui-host.js";
import { PanelHost } from "./tui/panel-host.js";
import { Vim } from "./tui/vim.js";
import { forkCut, lineage, projectUserTurns, rewindTarget } from "./rewind.js";
import { renderJobs } from "./tui/jobs.js";
import { groupMcpTools, renderMcp } from "./tui/mcp.js";
import { LANGS, currentLanguage, isLang, setLanguage } from "./tui/i18n.js";
import { decodeLogBytes, parseLogMessages, searchSessions } from "./cross-find.js";
import { encodeSegment, projectKey, sessionsRoot } from "./sessions-store.js";
import { SessionTabs } from "./session-tabs.js";
import { SearchState } from "./search-state.js";
import { TurnRunner } from "./turn-runner.js";
import { labelFor, promptBlocks } from "./tui-adapt.js";
import { LoginFlow } from "./login-flow.js";
import { copyWithLocalHelper, describeError, mediaTypeOf, openUrlWithLocalHelper, timestampForFile, } from "./local-platform.js";
import { listSessions, listSessionsWithParents, parentOf, readHistory, sessionEvents, } from "./session-list.js";
import { ApprovalPanel, LoginPanel, QuestionsPanel, interpretApproval, } from "./tui/panels.js";
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions';
import { keyReference, findMatches, hostLabel, layout, maxScrollBack, render, tabClickTarget, } from "./tui/view.js";
import { activeTheme, applyTheme, listThemes } from "./tui/theme.js";
import { DEFAULT_THEME, findTheme } from "./tui/themes.js";
import { projectStreamChunk } from "./tui/stream.js";
import { applyToolEvent } from "./tui/tooldetail.js";
import { transcriptMarkdown } from "./tui/export.js";
import { deleteStoredSessionDir, findStoredSessionDir } from "./sessions-store.js";
import { planRename, snapshotTitle } from "./rename.js";
import { activeProfileName, forgetPlugin, isPluginEnabled, listPlugins, parsePackageRequest, readProfileManifest, resolveProfileDir, runPackageManager, setPluginEnabled, writeProfileManifest, } from "./plugins.js";
import { assembleState, loadState, MAX_RESTORED_SESSIONS, restorePlan, saveStateSync, } from "./persist.js";
import { VERSION } from "./version.js";
import { SESSION_MS, WEEK_MS, bucketDelta, isEmptyBuckets, noBuckets, UsageStore, } from "./usage.js";
import { collectPlans, hasProbe, PlanCache } from "./credits.js";
import { UsageView } from "./tui/usage-view.js";
import { FleetView, dispatchArgv, isValidPeer, PeerList, jumpArgv, jumpCommand, mergeFleet, } from "./tui/fleet.js";
import { buildOsc52, wrapForMultiplexer } from "./tui/osc52.js";
import { PresencePublisher } from "./presence.js";
import { collectFleet, localDshHome } from "./fleet-sources.js";
import { insertionFor, resolveVoiceSetup, startRecording, stopRecording, systemProbe, transcribe, voiceGapMessage, voiceOptionsFromEnv, } from "./voice.js";
/** Stable Cordis plugin name. */
export const name = 'moqi';
/** Core services required before the terminal can open. */
export const inject = ['agentDefaultModel', 'agents', 'sessions'];
export const Config = z.object({
    resumeSessionId: z.string(),
    model: z.string(),
    thinking: z.boolean(),
    contextLimit: z.number(),
    mouse: z.boolean(),
    bell: z.boolean(),
    vim: z.boolean(),
    peers: z.array(z.string()),
    restore: z.boolean(),
    voiceModel: z.string(),
    voiceBin: z.string(),
    dispatchProfile: z.string(),
});
/** Spinner frames for the streaming indicator. */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** Sentinel id for the picker row that opens a new session. */
const NEW_SESSION_ROW = 'new-session';
/** Context budget assumed when the provider publishes no capacity. */
const DEFAULT_CONTEXT_LIMIT = 65536;
/** How often the spinner advances while a reply streams, in milliseconds. */
const SPINNER_INTERVAL = 80;
/** A second ctrl+c within this window quits; outside it the timer resets. */
const QUIT_CONFIRM_MS = 1500;
/** Commands this app implements itself, on top of whatever the Harness adds. */
const BUILTIN_COMMANDS = [
    { name: 'new', args: '', description: 'Open another session alongside this one' },
    { name: 'sessions', args: '', description: 'Switch between open sessions' },
    { name: 'close', args: '', description: 'Close this session' },
    { name: 'resume', args: '', description: 'Pick up an earlier session' },
    { name: 'delete', args: '', description: 'Delete a stored session for good' },
    {
        name: 'rename',
        args: '[title]',
        description: 'Name this session; no argument regenerates the automatic title',
    },
    { name: 'model', args: '[name]', description: 'Switch model; no argument lists them' },
    { name: 'theme', args: '[name]', description: 'Switch the color palette; no argument lists them' },
    {
        name: 'plugins',
        args: '[add <pkg> | remove <pkg>]',
        description: 'The packages this profile composes; no argument lists them',
    },
    { name: 'thinking', args: '', description: "Toggle display of the reasoner's chain-of-thought" },
    { name: 'tools', args: '', description: 'List the tools this agent can call' },
    { name: 'usage', args: '[reset]', description: 'Token usage by provider, tallied since it was last reset' },
    { name: 'export', args: '[file]', description: 'Write this transcript to a markdown file' },
    {
        name: 'find',
        args: '<text> | --sessions <text>',
        description: 'Search this transcript, or every stored session, for text',
    },
    { name: 'unqueue', args: '', description: 'Discard prompts queued while a reply was streaming' },
    {
        name: 'interrupt',
        args: '',
        description: 'Stop the streaming reply and run the queued prompts now',
    },
    { name: 'copy', args: '', description: 'Copy the last reply to the system clipboard' },
    {
        name: 'rewind',
        args: '',
        description: 'Redo an earlier prompt in a forked session that keeps the history before it',
    },
    { name: 'fork', args: '', description: 'Copy this session into a resumable twin' },
    { name: 'tree', args: '', description: 'Show this session’s family tree of forks' },
    { name: 'jobs', args: '[kill <id>]', description: 'Background jobs: what is running and what finished' },
    { name: 'mcp', args: '', description: 'MCP servers whose tools are mounted here' },
    { name: 'lang', args: '[en|zh-CN]', description: 'Interface language' },
    { name: 'providers', args: '', description: 'Sign in to a provider — Claude Pro/Max, ChatGPT/Codex, and others' },
    {
        name: 'dispatch',
        args: '<device> <task>',
        description: 'Run a task on a peer through its headless profile',
    },
    { name: 'fleet', args: '', description: 'Sessions across every device (ctrl+f)' },
    { name: 'peer', args: '[add|rm <host>]', description: 'Devices the fleet overview reads' },
    { name: 'update', args: '', description: 'Update this package from npm, if a newer one exists' },
    { name: 'help', args: '', description: 'Show keys and commands' },
    { name: 'exit', args: '', description: 'Quit dsh' },
];
/** Create an empty session record. */
function newTab(id) {
    return {
        id,
        agent: undefined,
        title: '',
        messages: [],
        streaming: false,
        streamingSegments: [],
        streamingReasoning: '',
        streamStartedAt: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        haveUsage: false,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        turnStartTokens: 0,
        billedAtLastFold: noBuckets(),
        tps: 0,
        scrollBack: 0,
        queued: [],
        drainQueue: false,
        status: 'idle',
        logSyncedSeq: 0,
        selection: { current: undefined, assembled: undefined },
        modelName: '',
        theme: DEFAULT_THEME,
        contextLimit: 0,
        background: new Map(),
    };
}
/** The app: owns the screen, the sessions, and every piece of mutable state. */
class TuiApp {
    /** The open-session strip: owns the tabs and the rules between them. */
    tabStrip;
    /** The session currently on screen. */
    get tab() {
        const tab = this.tabStrip.current();
        if (tab !== undefined)
            return tab;
        // Unreachable in practice; keeps every accessor total rather than optional.
        const replacement = newTab('pending');
        this.tabStrip.replaceAll([replacement], 0);
        return replacement;
    }
    /** Open sessions, in creation order. */
    get tabs() {
        return this.tabStrip.tabs;
    }
    set tabs(tabs) {
        this.tabStrip.tabs = tabs;
    }
    /** Index into {@link tabs} of the session being drawn. */
    get active() {
        return this.tabStrip.active;
    }
    set active(index) {
        this.tabStrip.active = index;
    }
    screen;
    composer = new Composer();
    palette = new Palette();
    picker = new Picker();
    /** The `@` file-completion menu, driven by the composer like the palette. */
    atMenu = new AtMenu();
    /** Index of the transcript turn under selection, if any. */
    selectedTurn;
    /** The trust-surface panel on screen, if any: it owns the keyboard. */
    panel;
    /** The masked-prompt channel `askSecret` waits on, apart from any sign-in. */
    secretPrompt;
    pendingApprovals = [];
    pendingQuestions = [];
    /** The running sign-in: its panel, prompt, and abort state. */
    loginFlow;
    /** The host adapter for plugin-contributed panels. */
    panelHost;
    /** What `/providers` last listed, indexed the same way its picker rows are. */
    loginEntries = [];
    /** Modal vim editing for the composer, off unless `--vim` asked for it at launch. */
    vim = new Vim();
    /** The extension seam other plugins register shortcuts and a status line into. */
    tuiHost;
    /** Hits from the last `/find --sessions`, indexed by picker row. */
    storedHits = [];
    /** Workspace file listing for `@` completion, rebuilt lazily. */
    fileIndex;
    /** The token esc dismissed, so typing more reopens the menu but esc stays. */
    atDismissed;
    /** Images staged for the next send, numbered as they were picked. */
    stagedImages = [];
    nextImageNo = 1;
    spinnerIndex = 0;
    spinnerTimer;
    status = '';
    statusIsError = false;
    overlay = '';
    showThinking;
    confirmState = new Confirm();
    /** Expanded by default: the transcript lists every tool call as it happens. */
    expandTools = true;
    expandBackground = false;
    /** Live agents other than the foreground one, keyed by session id. */
    /** Sent prompts, recalled with ↑/↓ on the composer's outer rows. */
    history = new InputHistory();
    /** The turn lifecycle: send, stream, settle, and the queue's drain rules. */
    turns = new TurnRunner({
        isForeground: (tab) => this.tabs[this.active] === tab,
        clearOverlay: () => {
            this.overlay = '';
        },
        followOutput: () => {
            this.scrollToBottom();
        },
        rememberPrompt: (text) => {
            this.history.add(text);
            this.persistSoon();
        },
        status: (text, isError) => {
            this.setStatus(text, isError);
        },
        repaint: () => {
            this.paint();
        },
        spinner: (on) => {
            if (on)
                this.startSpinner();
            else
                this.releaseSpinner();
        },
        setAbort: (controller) => {
            this.abort = controller;
        },
        // The runner only ever hands back a tab the app handed it, so these
        // narrow back to the app's own SessionTab shape.
        sessionStatus: (tab, status) => {
            this.tabStrip.setStatus(tab, status);
        },
        foldUsage: (tab, provider) => {
            this.foldBilledUsage(tab, provider);
        },
        syncToolLog: (tab) => {
            this.syncToolLog(tab);
        },
        flush: (tab) => {
            void this.flush(tab);
        },
        persist: () => {
            this.persistSoon();
        },
    });
    /** The active transcript search: its query, cursor, and jump math. */
    searchState = new SearchState();
    /** Read-only view of the live search, for callers that only test it. */
    get search() {
        return this.searchState.view();
    }
    /** Persisted state as last loaded or saved, and a write debounce. */
    persisted = {
        inputHistory: [],
        thinking: false,
        peers: [],
        sessions: [],
        activeSession: 0,
        usage: {},
        usageEntries: [],
    };
    persistTimer;
    /** Per-provider billed usage across every session, restored on launch. */
    usage = new UsageStore();
    /** The `/usage` dashboard's own open/closed state and last-drawn data. */
    usageView = new UsageView();
    /** The last provider-plan reading, reused briefly so reopens do not re-probe. */
    planCache = new PlanCache();
    /** What was in force before the themes picker opened a preview, restored on esc. */
    previewBaseTheme;
    /** What was in force before the language picker opened a preview, restored on esc. */
    previewBaseLang;
    /** Last-seen status of each background job, so a finish is observed as a transition. */
    jobStatus = new Map();
    /** The background-job watcher's interval. */
    jobsTimer;
    /** The cross-device overview, and what this device publishes to it. */
    fleet = new FleetView();
    /**
     * Devices the overview reads, from `--peer` and from what was saved.
     *
     * Held here rather than read from config each time because the pane can add
     * to it: needing a relaunch to see a machine you just remembered is the
     * whole reason this is editable.
     */
    peers;
    presence;
    /** Signature of the last published set, so an unchanged paint writes nothing. */
    presenceKey = '';
    /** Working directory the sessions were created in, reported in presence. */
    cwd = process.cwd();
    /**
     * Push-to-talk state.
     *
     * `voicePhase` is what the footer draws and `voiceRecording` is the process
     * behind it. They are separate because transcription outlives the recorder:
     * the phase is still `transcribing` long after the child has exited.
     */
    voicePhase;
    voiceRecording;
    /** Resolved once per take, so the transcriber uses what the recorder used. */
    voiceSetup;
    abort;
    disposers = [];
    stopped = false;
    /** Epoch millis of the last ctrl+c that armed the quit confirmation. */
    lastQuitRequest = 0;
    ctx;
    config;
    exit;
    constructor(ctx, config, exit) {
        this.ctx = ctx;
        this.config = config;
        this.exit = exit;
        this.tabStrip = new SessionTabs([newTab('pending')], { bell: config.bell !== false });
        // Seeded empty; the launch path replaces this with config + persisted peers.
        this.peers = new PeerList();
        this.loginFlow = new LoginFlow(() => this.ctx.get('authorization'), {
            mount: (panel) => {
                this.panel = panel;
            },
            status: (text, isError) => {
                this.setStatus(text, isError);
            },
            repaint: () => {
                this.paint();
            },
            clipboard: (url) => this.writeClipboard(url).ok,
            offerMethods: (entry) => {
                this.picker.show('login-method', `Sign in — ${entry.label}`, entry.methods.map((method) => ({ id: method.id, title: method.label, subtitle: '' })));
                this.paint();
            },
        });
        this.showThinking = config.thinking === true;
        this.vim.setEnabled(config.vim === true);
        this.tuiHost = new TuiHost(ctx);
        this.panelHost = new PanelHost(this.tuiHost, {
            showList: (title, rows, select) => {
                this.picker.show('panel', title, [...rows]);
                if (select !== undefined)
                    this.picker.selectById(select);
            },
            askSecret: (title, message, placeholder) => this.askSecret(title, message, placeholder),
            report: (text) => {
                this.setStatus(text);
            },
            fail: (error) => {
                this.setStatus(describeError(error), true);
            },
            paint: () => {
                this.paint();
            },
        });
        this.presence = new PresencePublisher(localDshHome());
        this.screen = new Screen({
            onKey: (key) => {
                this.handleKey(key);
            },
            onResize: () => {
                this.paint();
            },
        }, { mouse: config.mouse !== false });
    }
    /** Boot the app: resolve the agent, open the screen, and paint. */
    async start() {
        await this.ctx.get('loader')?.await();
        const agents = this.ctx.get('agents');
        const defaultModel = this.ctx.get('agentDefaultModel');
        if (agents === undefined || defaultModel === undefined)
            return;
        // Adopt whatever survived the last run before deciding what to show: the
        // composer history and the thinking preference, both best-effort.
        this.persisted = await loadState();
        this.usage.restore(this.persisted.usage, this.persisted.usageEntries);
        this.history.load(this.persisted.inputHistory);
        if (this.config.thinking === undefined)
            this.showThinking = this.persisted.thinking;
        if (this.persisted.theme !== undefined)
            applyTheme(this.persisted.theme);
        // The first tab was constructed before the persisted default was known;
        // sync it now so a `--resume`/fresh-session boot (which reuses this same
        // tab rather than replacing it) does not carry the built-in default while
        // the screen shows the persisted one.
        this.tab.theme = activeTheme();
        if (this.persisted.lang !== undefined && isLang(this.persisted.lang))
            setLanguage(this.persisted.lang);
        if (this.persisted.expandTools !== undefined)
            this.expandTools = this.persisted.expandTools;
        // Flags and remembered devices are one list from here on; a duplicate
        // between them should not make a peer appear twice in the overview.
        this.peers.replaceAll([...new Set([...(this.config.peers ?? []), ...this.persisted.peers])]);
        const selection = defaultModel.currentSelection();
        this.tab.selection.current =
            this.config.model === undefined ? selection : { ...selection, model: this.config.model };
        const current = this.tab.selection.current;
        const agentOptions = { provider: current.provider, model: current.model };
        this.tab.modelName = String(current.model);
        const setup = this.selectionSetupFor(this.tab);
        const fs = this.ctx.get('fs');
        const cwd = fs === undefined ? process.cwd() : fs.processPath(await fs.resolve('.'));
        this.cwd = cwd;
        this.fileIndex = new FileIndex(cwd);
        // An explicit --resume names exactly one session, so it outranks whatever
        // happened to be open last time: the user has already said what they want.
        if (this.config.resumeSessionId !== undefined) {
            const sessionId = brandString(this.config.resumeSessionId);
            const resumed = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup });
            this.tab.agent = resumed.agent;
            this.adoptForeground(this.tab);
            this.tab.id = String(sessionId);
            this.tab.title = this.config.resumeSessionId;
            this.tab.messages = readHistory(this.tab.agent.session);
            await this.tab.agent.whenIdle();
        }
        else if (await this.restoreSessions(current)) {
            // The restored active tab may carry a theme that diverged from the
            // persisted default in an earlier session; the boot-time apply above
            // only knew the default, not what this particular tab last used.
            applyTheme(this.tab.theme);
        }
        else {
            const sessionId = brandString(`session-${randomUUID()}`);
            const created = await agents.create({ sessionId, meta: { cwd }, agentOptions, setup });
            this.tab.agent = created.agent;
            this.adoptForeground(this.tab);
            this.tab.id = String(sessionId);
            await this.tab.agent.whenIdle();
        }
        this.subscribeToStream();
        this.subscribeToAgents();
        // Publishing is what makes this device visible to every other one.
        this.presence.start();
        this.publishPresence();
        for (const tab of this.tabs)
            void this.refreshContextLimit(tab);
        if (!Screen.isInteractive()) {
            throw new Error('the tui profile needs an interactive terminal; use --profile headless for scripted runs');
        }
        this.screen.start();
        this.installSignalHandlers();
        this.registerTrustSurfaces();
        // Five seconds is often enough to notice a finished job without the
        // watcher itself ever being felt; the interval is unref'd so a wart on
        // this timer can never keep the process alive at quit.
        this.jobsTimer = setInterval(() => this.watchJobs(), 5000);
        this.jobsTimer.unref?.();
        if (this.persisted.setupDone !== true)
            this.showSetupWizard();
        this.paint();
    }
    /**
     * Answer the agent's own questions: tool approvals and `ask_user_question`.
     *
     * Both seams are Cordis waterfalls. Claiming the request means returning an
     * outcome and showing a panel; delegating with `next()` means some other
     * UI — or the fail-closed default — decides. The app claims only when it is
     * actually drawing: a headless mount must never swallow a prompt it cannot
     * show, so everything unmatched falls through.
     */
    registerTrustSurfaces() {
        this.disposers.push(this.ctx.on('approval/request', async (request, next) => {
            if (!this.ownsRequest(request.agent))
                return await next();
            return await new Promise((resolve) => {
                const pending = { request, resolve };
                this.pendingApprovals.push(pending);
                if (request.signal !== undefined) {
                    request.signal.addEventListener('abort', () => {
                        this.dropApproval(pending);
                        resolve('cancelled');
                    }, { once: true });
                }
                if (this.panel === undefined)
                    this.activateNextPanel();
                this.paint();
            });
        }));
        this.disposers.push(this.ctx.on('user-questions/request', async (request, next) => {
            if (request.agent !== undefined && !this.ownsRequest(request.agent))
                return await next();
            return await new Promise((resolve, reject) => {
                const pending = { request, resolve, reject };
                this.pendingQuestions.push(pending);
                if (request.signal !== undefined) {
                    request.signal.addEventListener('abort', () => {
                        this.dropQuestion(pending);
                        reject(new UserQuestionError('the user closed the question', 'ASK_CANCELLED'));
                    }, { once: true });
                }
                if (this.panel === undefined)
                    this.activateNextPanel();
                this.paint();
            });
        }));
    }
    /** Whether an ask belongs to an agent this terminal is driving. */
    ownsRequest(agent) {
        if (this.stopped)
            return false;
        if (agent === undefined)
            return Screen.isInteractive();
        // Subagents delegate from a tab's agent; the root of the lineage is ours.
        if (this.tabs.some((tab) => tab.agent === agent))
            return true;
        return false;
    }
    /** Show the oldest waiting panel, if no panel is up. */
    activateNextPanel() {
        if (this.panel !== undefined)
            return;
        const approval = this.pendingApprovals[0];
        if (approval !== undefined) {
            this.panel = new ApprovalPanel(approval.request.toolName, approval.request.reason, this.commandForCall(approval.request.callId));
            return;
        }
        const question = this.pendingQuestions[0];
        if (question !== undefined) {
            this.panel = new QuestionsPanel([...question.request.questions]);
        }
    }
    /** The full command behind an approval, read from the tool call already streamed. */
    commandForCall(callId) {
        if (callId === undefined)
            return undefined;
        for (const message of this.tab.messages) {
            for (const tool of messageTools(message)) {
                if (tool.id === callId && tool.detail !== undefined)
                    return tool.detail;
            }
        }
        const streaming = findTool(this.tab.streamingSegments, (tool) => tool.id === callId && tool.detail !== undefined);
        return streaming?.detail;
    }
    dropApproval(pending) {
        const at = this.pendingApprovals.indexOf(pending);
        if (at !== -1)
            this.pendingApprovals.splice(at, 1);
    }
    dropQuestion(pending) {
        const at = this.pendingQuestions.indexOf(pending);
        if (at !== -1)
            this.pendingQuestions.splice(at, 1);
    }
    /**
     * Answer the open approval and move on to whoever is next in line.
     */
    settleApproval(panel, decision) {
        const pending = this.pendingApprovals.shift();
        this.panel = undefined;
        this.activateNextPanel();
        if (pending !== undefined) {
            this.setStatus(decision === 'allowed-once' ? `allowed ${panel.toolName} once` : `denied ${panel.toolName}`);
            pending.resolve(decision);
        }
        this.paint();
    }
    settleQuestion(panel, cancel) {
        const pending = this.pendingQuestions.shift();
        this.panel = undefined;
        this.activateNextPanel();
        if (pending !== undefined) {
            if (cancel)
                pending.reject(new UserQuestionError('the user cancelled the question', 'ASK_CANCELLED'));
            else
                pending.resolve({ answers: panel.answers() });
        }
        this.paint();
    }
    /** Keys while a trust-surface panel owns the keyboard. */
    handlePanelKey(key) {
        const panel = this.panel;
        if (panel === undefined)
            return;
        // The microphone outranks the panel: a live take is the most modal state
        // the app has, so esc cancels it rather than deciding the request.
        if (this.voicePhase !== undefined) {
            if (key.name === 'esc') {
                this.cancelVoice();
                return;
            }
            if (key.name === 'ctrl+v') {
                this.toggleVoice();
                return;
            }
        }
        if (panel instanceof LoginPanel) {
            switch (key.name) {
                case 'up':
                case 'ctrl+p':
                    panel.move(-1);
                    break;
                case 'down':
                case 'ctrl+n':
                    panel.move(1);
                    break;
                case 'enter': {
                    const value = panel.answer();
                    if (value !== undefined && (this.loginFlow.answer(value) || this.answerSecret(value))) {
                        panel.setPrompt(undefined);
                        break;
                    }
                    // No question waiting: enter on a notice with a page to open opens
                    // it, rather than typing the URL out for a human to click or copy.
                    const url = panel.notice?.url;
                    if (url !== undefined) {
                        this.setStatus(openUrlWithLocalHelper(url) ? `opened ${url}` : `could not open a browser — copy it yourself: ${url}`);
                    }
                    break;
                }
                case 'esc':
                case 'ctrl+c': {
                    if (this.loginFlow.decline() || this.cancelSecret()) {
                        // A question the surface can recover from: decline just this one,
                        // the same "no" a human gives to any single question.
                        panel.setPrompt(undefined);
                    }
                    else {
                        // Nothing waiting on an answer: esc/ctrl+c withdraws the whole
                        // attempt instead. `begin()` still has to settle asynchronously,
                        // so the panel closes once that promise resolves, not here.
                        this.setStatus('cancelling…');
                        this.loginFlow.withdraw();
                    }
                    this.paint();
                    return;
                }
                case 'backspace':
                    panel.backspaceText();
                    break;
                default:
                    if (key.text !== '')
                        panel.typeText(key.text);
                    break;
            }
            this.paint();
            return;
        }
        if (panel instanceof ApprovalPanel) {
            switch (key.name) {
                case 'ctrl+v':
                    if (this.voicePhase === undefined)
                        this.toggleVoice();
                    return;
                case 'up':
                case 'ctrl+p':
                    panel.move(-1);
                    break;
                case 'down':
                case 'ctrl+n':
                    panel.move(1);
                    break;
                case '1':
                    this.settleApproval(panel, 'allowed-once');
                    return;
                case '2':
                    this.settleApproval(panel, 'rejected');
                    return;
                case 'enter':
                    this.settleApproval(panel, panel.decision());
                    return;
                case 'esc':
                case 'ctrl+c':
                    // Fail closed: esc means no.
                    this.settleApproval(panel, 'rejected');
                    return;
                default:
                    break;
            }
            this.paint();
            return;
        }
        switch (key.name) {
            case 'up':
            case 'ctrl+p':
                panel.move(-1);
                break;
            case 'down':
            case 'ctrl+n':
                panel.move(1);
                break;
            // The decoder reports space as printable text, not as a named key, so
            // the multi-select toggle has to match what actually arrives.
            case ' ':
                panel.toggle();
                break;
            case 'tab':
                panel.focusCustom();
                break;
            case 'enter': {
                const state = panel.advance();
                if (state === 'done') {
                    this.settleQuestion(panel, false);
                    return;
                }
                if (state === 'empty')
                    this.setStatus('choose an option or type an answer');
                break;
            }
            case 'esc':
                if (!panel.back()) {
                    this.settleQuestion(panel, true);
                    return;
                }
                break;
            case 'ctrl+c':
                this.settleQuestion(panel, true);
                return;
            case 'backspace':
                panel.backspaceText();
                break;
            default:
                if (key.text !== '')
                    panel.typeText(key.text);
                break;
        }
        this.paint();
    }
    /**
     * Bring back the sessions that were open at the last exit.
     *
     * Restoring must never be the reason the app fails to open, so every step
     * degrades on its own: an id the store no longer holds is dropped before
     * anything tries to adopt it, an adoption that throws costs only that tab,
     * and coming back empty-handed returns `false` so the caller falls through
     * to creating a fresh session. The worst outcome is the behaviour the app
     * had before any of this existed.
     *
     * @param seed - selection a restored tab falls back to when it has no model
     *   of its own recorded.
     * @returns whether at least one session came back.
     */
    async restoreSessions(seed) {
        if (this.config.restore === false)
            return false;
        if (this.persisted.sessions.length === 0)
            return false;
        // Probe the store first so the plan only ever names sessions that exist.
        // `/delete` prunes it, and so does anything else that touched $DSH_HOME
        // between two runs, which makes a dangling id ordinary rather than an
        // error. Stopping once the cap is met bounds the scan for a state file
        // that has been hand-edited into something far longer than a tab bar.
        const present = new Set();
        for (const session of this.persisted.sessions) {
            if (present.size >= MAX_RESTORED_SESSIONS)
                break;
            try {
                if ((await findStoredSessionDir(session.id)) !== undefined)
                    present.add(session.id);
            }
            catch {
                // An unreadable store is indistinguishable from an absent session.
            }
        }
        const plan = restorePlan(this.persisted, (id) => present.has(id));
        // Track the active tab by id rather than by position, because the entries
        // that fail to adopt close the gaps up underneath the index.
        const wanted = plan.sessions[plan.active]?.id;
        const restored = [];
        for (const session of plan.sessions) {
            const tab = await this.adoptSession(session, seed);
            if (tab !== undefined)
                restored.push(tab);
        }
        if (restored.length === 0)
            return false;
        this.tabs = restored;
        const active = restored.findIndex((tab) => tab.id === wanted);
        this.active = active === -1 ? 0 : active;
        return true;
    }
    /**
     * Re-adopt one remembered session as a tab, or give up on it quietly.
     *
     * This is {@link TuiApp.openSession} without the screen: the Agent is
     * resumed against the tab's own selection ref and the transcript is read
     * straight back out of the session log, because a restored conversation
     * that came back blank would read as data loss rather than as a resume.
     */
    async adoptSession(session, seed) {
        const agents = this.ctx.get('agents');
        if (agents === undefined)
            return undefined;
        const tab = newTab(session.id);
        tab.title = session.title;
        // A theme this build no longer ships (a renamed or removed one) falls
        // back to the current default rather than leaving the tab on whatever
        // `newTab` happened to hardcode.
        if (session.theme !== undefined && findTheme(session.theme) !== undefined) {
            tab.theme = session.theme;
        }
        else {
            tab.theme = activeTheme();
        }
        // The model a conversation was switched to belongs to that conversation
        // rather than to the profile, so it comes back per tab instead of from the
        // shared default, which the user may have left pointing somewhere else.
        const selection = session.model === '' ? seed : { ...seed, model: session.model };
        tab.selection.current = selection;
        tab.modelName = String(selection.model);
        try {
            const resumed = await agents.resume({
                resumeSessionId: brandString(session.id),
                agentOptions: { provider: selection.provider, model: selection.model },
                setup: this.selectionSetupFor(tab),
            });
            tab.agent = resumed.agent;
            await tab.agent.whenIdle();
            tab.messages = readHistory(resumed.agent.session);
        }
        catch {
            // A session the Harness declines to adopt is one we do not bring back.
            return undefined;
        }
        return tab;
    }
    /**
     * Agent setup for one session: couples that tab's own selection ref to the
     * new Agent's context. `installModelSelection` binds this exact object to
     * Agent-scoped prompt assembly and request routing, and the Agent re-reads
     * `current` when each step enters assembly — so a model switch is a
     * mutation of the tab's ref, and every tab mutates only its own. Handing
     * every Agent the same ref (the previous design) is exactly how a switch in
     * one session silently rerouted all the others.
     */
    selectionSetupFor(tab) {
        return (agentCtx) => {
            installModelSelection(agentCtx, tab.selection);
        };
    }
    /** Tear the terminal down and release every subscription. */
    stop() {
        if (this.stopped)
            return;
        this.stopped = true;
        this.stopSpinner();
        if (this.jobsTimer !== undefined) {
            clearInterval(this.jobsTimer);
            this.jobsTimer = undefined;
        }
        // A recorder left running would keep the microphone open after the app
        // it belonged to is gone, with nothing on screen to say so.
        if (this.voiceRecording !== undefined)
            this.cancelVoice();
        this.persistNow();
        // Drop this device's presence records so it does not linger as stale.
        this.presence.stop();
        for (const dispose of this.disposers) {
            try {
                dispose();
            }
            catch {
                // Teardown is best-effort: one bad disposer must not strand the screen.
            }
        }
        this.disposers = [];
        this.screen.stop();
    }
    /** Restore the terminal even when the process is killed from outside. */
    installSignalHandlers() {
        process.on('SIGTERM', this.onHangupOrTerminate);
        process.on('SIGHUP', this.onHangupOrTerminate);
        this.disposers.push(() => {
            process.off('SIGTERM', this.onHangupOrTerminate);
            process.off('SIGHUP', this.onHangupOrTerminate);
        });
    }
    /** Bound once so {@link installSignalHandlers} and a terminal handover can add and remove the same listener. */
    onHangupOrTerminate = () => {
        this.stop();
        this.exit(0);
    };
    /**
     * Give a child process the terminal for the duration of `run`, the way
     * `$VISUAL`/`$EDITOR` and an attached remote session both need to.
     *
     * SIGHUP is ignored for the duration. A child that takes over the tty — ssh
     * allocating a remote pty is the known case — can leave the terminal's
     * controlling-process bookkeeping in a state that delivers a stray SIGHUP to
     * *this* process once the child exits, and without this guard that read as
     * the terminal itself hanging up: `installSignalHandlers` tore the whole app
     * down, which looked exactly like an unwanted restart from a fleet attach
     * that in fact ended cleanly. A real disconnect still ends the child (ssh's
     * own pipe breaks), which surfaces as an ordinary exit code here instead.
     */
    async withTerminalHandedOver(run) {
        process.off('SIGHUP', this.onHangupOrTerminate);
        this.screen.stop();
        try {
            return await run();
        }
        finally {
            this.screen.start();
            // `start()` clears the real terminal, but the diff cache does not know
            // that: left alone, the next paint compares against frame content that
            // is still sitting in memory from before the child took over, decides
            // most of it is unchanged, and skips writing it — leaving everything
            // but whatever actually changed sitting on a blank screen. Observed
            // live: an editor spawn that failed came back to a screen with nothing
            // on it but the new status line.
            this.screen.invalidate();
            process.on('SIGHUP', this.onHangupOrTerminate);
        }
    }
    /** Project the live assistant stream into the transcript. */
    subscribeToStream() {
        const dispose = this.ctx.on('agent/assistant-stream', (payload) => {
            // Any open session may be streaming, not just the one on screen.
            const tab = this.tabStrip.forAgent(payload.agent);
            if (tab === undefined)
                return;
            this.onFrame(tab, payload.frame);
        });
        this.disposers.push(dispose);
    }
    /**
     * Which session a delegated agent belongs to.
     *
     * The Harness does not hand us a delegation parent: `parentSession` on the
     * header is fork lineage, which a subagent need not have. What is reliable
     * is timing -- delegated work is spawned while its parent's turn runs -- so
     * the streaming session claims it, and `parentSession` is honoured first on
     * the occasions it does point at a session we have open. With neither, the
     * session on screen is the only honest guess.
     */
    ownerOf(agent) {
        const parent = agent.session.header.parentSession;
        const index = ownerOfDelegated(this.tabs, parent === undefined ? undefined : String(parent), this.active);
        return this.tabs[index] ?? this.tab;
    }
    /**
     * Claim an agent as a session's foreground, retracting it from every
     * delegated list.
     *
     * `agent/created` fires before the caller can store the agent on its tab, so
     * a newly opened session is briefly indistinguishable from delegated work
     * and gets banked as such. Nothing retracted it afterwards, which is exactly
     * how a second session's own agent came to sit in the first session's strip.
     */
    adoptForeground(tab) {
        const agent = tab.agent;
        if (agent === undefined)
            return;
        const id = String(agent.session.header.id);
        for (const other of this.tabs)
            other.background.delete(id);
    }
    /**
     * Track every other live agent, so delegated work is visible.
     *
     * The transcript only ever shows the foreground agent. A turn that spawns
     * subagents would otherwise look idle while the machine is busy, so the
     * lifecycle events feed a strip above the composer.
     */
    subscribeToAgents() {
        const note = (agent, status) => {
            const header = agent.session.header;
            // Ask the session what it is rather than inferring it. A delegated child
            // is marked as one; a session the user opened is not, whoever happens to
            // be on screen. The old test -- "not the active tab's agent" -- called
            // every other open session's foreground agent delegated work, and it
            // also raced: agent/created fires before the caller can store the agent
            // on its tab, so even the first session briefly qualified.
            if (header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0)
                return;
            if (this.tabs.some((tab) => tab.agent === agent))
                return;
            const id = String(header.id);
            const owner = this.ownerOf(agent);
            // A refreshed status must not duplicate the row into a second session if
            // the owner is resolved differently later in the turn.
            const held = this.tabs.find((tab) => tab.background.has(id));
            const target = held ?? owner;
            const existing = target.background.get(id);
            if (existing === undefined) {
                target.background.set(id, {
                    id,
                    label: labelFor(agent),
                    status,
                    depth: header.delegationDepth ?? 1,
                    startedAt: Date.now(),
                });
            }
            else {
                existing.status = status;
            }
            this.paint();
        };
        this.disposers.push(this.ctx.on('agent/created', (payload) => {
            note(payload.agent, 'idle');
            return undefined;
        }));
        this.disposers.push(this.ctx.on('agent/status', (payload) => {
            note(payload.agent, payload.status);
            return undefined;
        }));
        this.disposers.push(this.ctx.on('agent/disposed', (payload) => {
            if (this.tabs.some((tab) => tab.agent === payload.agent))
                return;
            const id = String(payload.agent.session.header.id);
            for (const tab of this.tabs)
                tab.background.delete(id);
            this.paint();
        }));
    }
    /**
     * Apply one stream frame. `start` and `end` carry no chunk; the projection
     * lives in `tui/stream.ts` so it is replayable without a Harness runtime.
     * Unknown chunk kinds are ignored on purpose, because the union is
     * merge-extensible and a plugin may add one this app has never heard of.
     */
    onFrame(tab, frame) {
        if (frame.type !== 'chunk')
            return;
        projectStreamChunk(tab, frame.chunk);
        this.syncToolLog(tab);
        if (tab === this.tabs[this.active])
            this.paint();
    }
    /**
     * Fold session-log events the stream cannot see onto the turn's tool rows.
     *
     * `tool/call` says what a call does; `tool/result` settles it — ok or
     * error — and attaches its outcome under that very row, so feedback rides
     * in the transcript flow instead of a detached status line. Called from the
     * frame handler and the spinner tick: results land while no chunk streams.
     */
    syncToolLog(tab) {
        const session = tab.agent?.session;
        if (session === undefined)
            return;
        const length = session.seq;
        while (tab.logSyncedSeq < length) {
            const event = session.eventAt(SessionSeq(tab.logSyncedSeq));
            if (event !== undefined)
                applyToolEvent(segmentTools(tab.streamingSegments), event);
            tab.logSyncedSeq += 1;
        }
    }
    /**
     * Set the context budget the footer measures against, for one session.
     *
     * An explicit --context-limit wins; otherwise the provider's own capacity
     * for that session's exact model is used, so the bar reflects the model
     * actually answering (GLM-5.3 is 200K, not the 64K a hardcoded default
     * would show). A provider that does not publish a capacity falls back to
     * the flag's default.
     */
    async refreshContextLimit(tab = this.tab) {
        if (this.config.contextLimit !== undefined) {
            tab.contextLimit = this.config.contextLimit;
            return;
        }
        const fallback = DEFAULT_CONTEXT_LIMIT;
        const llm = this.ctx.get('llm');
        const selection = tab.selection.current;
        if (llm === undefined || selection === undefined) {
            tab.contextLimit = tab.contextLimit === 0 ? fallback : tab.contextLimit;
            return;
        }
        try {
            const info = await llm.resolveModelInfo(selection.provider, selection.model);
            const window = info.context?.contextWindow;
            tab.contextLimit = window !== undefined && window > 0 ? window : fallback;
        }
        catch {
            // An unreachable route must not blank the status bar.
            tab.contextLimit = tab.contextLimit === 0 ? fallback : tab.contextLimit;
        }
        if (tab === this.tabs[this.active])
            this.paint();
    }
    /** Every command the palette offers: this app's, plus the Harness registry's. */
    commands() {
        const registry = this.ctx.get('commands');
        const fromHarness = [];
        if (registry !== undefined && this.tab.agent !== undefined) {
            try {
                for (const descriptor of registry.list(this.tab.agent) ?? []) {
                    fromHarness.push({
                        name: String(descriptor.name),
                        args: String(descriptor.input?.hint ?? ''),
                        description: String(descriptor.description ?? ''),
                    });
                }
            }
            catch {
                // Discovery is best-effort; the built-ins still work without it.
            }
        }
        const seen = new Set(fromHarness.map((command) => command.name.toLowerCase()));
        const merged = [...fromHarness];
        for (const command of BUILTIN_COMMANDS) {
            if (seen.has(command.name.toLowerCase()))
                continue;
            merged.push(command);
            seen.add(command.name.toLowerCase());
        }
        // Panels contributed by other plugins are commands too: `/JevLoop` is the
        // plugin's, not this app's. A built-in or Harness command of the same name
        // wins here, and `runCommand` honors that too, so the palette never lies.
        for (const command of this.panelHost.commands()) {
            const key = command.name.trim().toLowerCase();
            if (key === '' || seen.has(key))
                continue;
            merged.push({ name: command.name, args: '', description: command.description });
            seen.add(key);
        }
        merged.sort((left, right) => left.name.localeCompare(right.name));
        return merged;
    }
    // ----------------------------------------------------------------- sessions
    /** Switch the view to another session. */
    selectSession(index) {
        const tab = this.tabStrip.select(index);
        if (tab === undefined)
            return;
        // Each session can be on its own palette; switching to one repaints in
        // its color, not whichever tab last called /theme.
        applyTheme(tab.theme);
        // Which tab you were on is part of what a restart should bring back.
        this.persistSoon();
        this.picker.hide();
        this.palette.close();
        this.setStatus('');
        this.screen.invalidate();
        this.paint();
    }
    /** Close a session, keeping at least one open. */
    closeSession(index) {
        const removed = this.tabStrip.remove(index);
        if (removed === undefined) {
            this.setStatus('the last session cannot be closed — /new opens another', true);
            this.paint();
            return;
        }
        if (removed.closed.streaming === true)
            this.setStatus('closed a session that was still replying');
        // Closing a tab can leave a different one active, on its own palette.
        applyTheme(this.tab.theme);
        // A closed session must not come back on the next launch.
        this.persistSoon();
        this.screen.invalidate();
        this.paint();
    }
    // ---------------------------------------------------------------- rendering
    snapshot() {
        const size = this.screen.size();
        return {
            columns: size.columns,
            rows: size.rows,
            title: this.tab.title,
            host: hostLabel(process.env['DSH_HOST'] ?? 'local harness'),
            modelName: this.tab.modelName,
            messages: this.tab.messages,
            streamingSegments: this.tab.streamingSegments,
            streamingReasoning: this.tab.streamingReasoning,
            streaming: this.tab.streaming,
            spinner: SPINNER[this.spinnerIndex % SPINNER.length] ?? '',
            status: this.status,
            statusIsError: this.statusIsError,
            overlay: this.overlay,
            showThinking: this.showThinking,
            composer: this.composer,
            palette: this.palette,
            atMenu: this.atMenu,
            picker: this.picker,
            scrollBack: this.tab.scrollBack,
            queued: this.tab.queued.map((prompt) => prompt.text),
            sessions: this.tabStrip.summaries(),
            expandTools: this.expandTools,
            background: [...this.tab.background.values()],
            expandBackground: this.expandBackground,
            elapsedSeconds: this.tab.streamStartedAt === 0 ? 0 : Math.floor((Date.now() - this.tab.streamStartedAt) / 1000),
            promptTokens: this.tab.promptTokens,
            completionTokens: this.tab.completionTokens,
            totalTokens: this.tab.totalTokens,
            haveUsage: this.tab.haveUsage,
            tps: this.tab.tps,
            cacheReadTokens: this.tab.cacheReadTokens,
            contextLimit: this.tab.contextLimit,
            confirming: this.confirmState.open,
            confirmText: this.confirmState.open ? this.confirmState.prompt : undefined,
            searchActive: this.search !== undefined,
            fleet: this.fleet,
            usage: this.usageView,
            panel: this.panel?.view(),
            selectedTurn: this.selectedTurn,
            pluginLine: this.tuiHost.statusLine(),
            vimMode: this.vim.enabled ? this.vim.mode : undefined,
            voice: this.voicePhase,
        };
    }
    paint() {
        if (this.stopped)
            return;
        // Paint is the one funnel every state change already goes through, and
        // publishPresence is a no-op unless the published set actually changed.
        // It is also the one funnel every picker change reaches, which is what
        // makes it the right place to keep a picker's live preview honest.
        this.syncPickerPreview();
        this.publishPresence();
        const frame = render(this.snapshot());
        this.screen.setCursor(frame.cursor);
        this.screen.paint(frame.lines);
    }
    setStatus(text, isError = false) {
        this.status = text;
        this.statusIsError = isError;
    }
    startSpinner() {
        if (this.spinnerTimer !== undefined)
            return;
        this.spinnerTimer = setInterval(() => {
            this.spinnerIndex += 1;
            // Tool results arrive between model streams, when no frame fires; the
            // tick is what keeps every streaming tab's rows settled.
            for (const open of this.tabs)
                if (open.streaming)
                    this.syncToolLog(open);
            this.paint();
        }, SPINNER_INTERVAL);
        // The timer must not hold the process open on its own.
        this.spinnerTimer.unref?.();
    }
    stopSpinner() {
        if (this.spinnerTimer === undefined)
            return;
        clearInterval(this.spinnerTimer);
        this.spinnerTimer = undefined;
    }
    /**
     * Stop the spinner only once nothing on screen still needs it.
     *
     * Two independent things animate it now — a streaming reply and a live
     * microphone — and either one finishing used to be enough to freeze the
     * other's indicator mid-frame.
     */
    releaseSpinner() {
        if (this.voicePhase !== undefined)
            return;
        if (this.tabs.some((open) => open.streaming))
            return;
        this.stopSpinner();
    }
    // ---------------------------------------------------------------- voice
    /**
     * The push-to-talk key: one press arms the microphone, the next transcribes.
     *
     * Hold-to-talk would be the obvious shape but a terminal cannot see a key
     * being released, so the two-press toggle is the only honest version of it.
     */
    toggleVoice() {
        if (this.voicePhase === 'transcribing') {
            this.setStatus('still transcribing the last take');
            this.paint();
            return;
        }
        if (this.voiceRecording !== undefined) {
            void this.finishVoice();
            return;
        }
        this.beginVoice();
    }
    /**
     * Start capturing, or say in one line why this machine cannot.
     *
     * Every failure here is a missing optional dependency rather than a fault,
     * so none of it is allowed to throw: the key press turns into a footer
     * message and the app carries on exactly as if voice did not exist.
     */
    beginVoice() {
        const resolution = resolveVoiceSetup({
            ...voiceOptionsFromEnv(),
            model: this.config.voiceModel,
            binary: this.config.voiceBin,
        }, systemProbe());
        if (!resolution.ok) {
            this.setStatus(voiceGapMessage(resolution.gap), true);
            this.paint();
            return;
        }
        const wavPath = join(tmpdir(), `moqi-voice-${randomUUID()}.wav`);
        try {
            this.voiceRecording = startRecording(resolution.setup, wavPath);
        }
        catch (error) {
            this.setStatus(`recorder failed: ${describeError(error)}`, true);
            this.paint();
            return;
        }
        // A recorder that dies on its own — no such device, a busy card — must not
        // leave the footer claiming the microphone is live forever.
        this.voiceRecording.child.once('error', (error) => {
            if (this.voicePhase !== 'recording')
                return;
            this.voicePhase = undefined;
            this.voiceRecording = undefined;
            this.releaseSpinner();
            this.setStatus(`recorder failed: ${error.message}`, true);
            this.paint();
        });
        this.voiceSetup = resolution.setup;
        this.voicePhase = 'recording';
        this.setStatus('');
        this.startSpinner();
        this.paint();
    }
    /**
     * Stop the recorder, run whisper, and splice the result into the composer.
     *
     * Nothing is sent: a misheard prompt that submits itself is worse than no
     * dictation at all, so the transcript lands at the cursor and the person
     * reads it before pressing enter. Both halves are awaited off the keypress,
     * so the screen keeps repainting and the spinner keeps turning throughout.
     */
    async finishVoice() {
        const recording = this.voiceRecording;
        const setup = this.voiceSetup;
        if (recording === undefined || setup === undefined)
            return;
        this.voiceRecording = undefined;
        this.voicePhase = 'transcribing';
        this.setStatus('');
        this.paint();
        try {
            await stopRecording(recording);
            const text = await transcribe(setup, recording.wavPath);
            // The take may have been abandoned while whisper was still thinking.
            if (this.voicePhase !== 'transcribing')
                return;
            // A take spoken at an approval panel answers it instead of typing: the
            // whole point of the panel is that the keyboard is captured, so the
            // dictation would otherwise land somewhere nobody can act on.
            if (this.panel instanceof ApprovalPanel) {
                const decision = interpretApproval(text);
                if (decision === undefined) {
                    this.setStatus('say "allow" or "deny" to answer the request');
                }
                else {
                    this.settleApproval(this.panel, decision);
                }
                return;
            }
            const insertion = insertionFor(this.composer.value(), this.composer.position(), text);
            if (insertion === '') {
                this.setStatus('heard nothing');
            }
            else {
                this.history.reset();
                this.composer.insert(insertion);
                this.setStatus('transcribed — edit it, then enter to send');
            }
        }
        catch (error) {
            this.setStatus(describeError(error), true);
        }
        finally {
            if (this.voicePhase === 'transcribing')
                this.voicePhase = undefined;
            this.releaseSpinner();
            void unlink(recording.wavPath).catch(() => {
                // A stray temp wav is untidy, not a failure worth reporting.
            });
            this.paint();
        }
    }
    /**
     * Throw the take away.
     *
     * `esc` has to reach the microphone before it reaches anything else on
     * screen: a live recording is the most modal thing the app ever does, and
     * the one state a person most urgently wants out of.
     */
    cancelVoice() {
        const recording = this.voiceRecording;
        this.voiceRecording = undefined;
        this.voiceSetup = undefined;
        this.voicePhase = undefined;
        this.releaseSpinner();
        if (recording !== undefined) {
            try {
                recording.child.kill('SIGKILL');
            }
            catch {
                // Already gone.
            }
            void unlink(recording.wavPath).catch(() => {
                // Best-effort; the file is in the system temp directory either way.
            });
        }
        this.setStatus('recording discarded');
        this.paint();
    }
    // ---------------------------------------------------------------- fleet
    /**
     * Publish what this device is doing, when it has changed.
     *
     * Called from every paint, so it must be cheap: the set is reduced to a
     * signature and nothing is written unless that signature moved. The
     * publisher's own heartbeat refreshes the timestamps in between, which is
     * what keeps a quiet device from ageing out as stale.
     */
    publishPresence() {
        const sessions = this.tabs
            // A tab with no agent has no session id worth publishing yet.
            .filter((tab) => tab.agent !== undefined)
            .map((tab) => ({
            sessionId: tab.id,
            title: tab.title,
            status: tab.streaming ? 'running' : tab.status === 'ready' ? 'ready' : 'idle',
            model: tab.modelName === '' ? undefined : tab.modelName,
            cwd: this.cwd,
        }));
        const key = JSON.stringify(sessions.map((session) => [session.sessionId, session.title, session.status]));
        if (key === this.presenceKey)
            return;
        this.presenceKey = key;
        this.presence.publish(sessions);
    }
    /**
     * Adopt a device, remembering it for next time.
     *
     * Flags and saved peers are one list once the app is running, so a device
     * added here is indistinguishable from one passed on the command line.
     */
    addPeer(host) {
        const result = this.peers.add(host);
        if (!result.ok) {
            this.setStatus(result.reason === 'invalid' ? `not a usable host: ${host.trim()}` : `${host.trim()} is already in the fleet`, result.reason === 'invalid');
            return false;
        }
        this.persistSoon();
        return true;
    }
    removePeer(host) {
        const removed = this.peers.remove(host);
        if (removed)
            this.persistSoon();
        return removed;
    }
    /** Open the overview and start a collection round. */
    openFleet() {
        this.fleet.show();
        this.picker.hide();
        this.palette.close();
        this.setStatus('');
        this.paint();
        void this.refreshFleet();
    }
    /**
     * One session's cumulative billed usage, as the Harness's own token meter
     * accounts for it — or undefined when it cannot be had.
     *
     * The `tokenUsage` projection is the only thing in reach that knows what a
     * provider actually billed: it folds the durable log, counts a retried attempt
     * as the second billed attempt it is, and reports the four buckets separately
     * because every provider prices them separately. Nothing else available to this
     * app can answer that — the stream's own `usage` frames carry the *latest*
     * request's absolute numbers, which is context pressure, not spend.
     *
     * Every failure mode returns undefined rather than a zero: the projection may
     * not be mounted in a given composition, the session may not be adopted yet,
     * and a shape this app does not recognize must not be read as "nothing was
     * billed". A ledger that silently stops recording is recoverable; one that
     * records confident zeros is not.
     */
    readBilledUsage(tab) {
        const session = tab.agent?.session;
        if (session === undefined)
            return undefined;
        const projections = this.ctx.get('sessionProjections');
        if (projections === undefined)
            return undefined;
        try {
            const value = projections.snapshot(session, ['tokenUsage']).values['tokenUsage'];
            if (typeof value !== 'object' || value === null)
                return undefined;
            const record = value;
            const read = (key) => {
                const raw = record[key];
                return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
            };
            const uncachedInputTokens = read('uncachedInputTokens');
            const outputTokens = read('outputTokens');
            const cacheReadTokens = read('cacheReadTokens');
            const cacheWriteTokens = read('cacheWriteTokens');
            if (uncachedInputTokens === undefined ||
                outputTokens === undefined ||
                cacheReadTokens === undefined ||
                cacheWriteTokens === undefined) {
                return undefined;
            }
            return { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
        }
        catch {
            // A projection read is a convenience; a composition that cannot serve it
            // must not be able to take a settled turn down with it.
            return undefined;
        }
    }
    /**
     * Fold whatever this session was billed since the last fold into the ledger,
     * attributed to the provider that answered.
     *
     * The baseline advances only when a reading succeeds, so a turn whose usage
     * could not be read is not lost — its spend is still in the session's
     * cumulative total and lands in the ledger the next time a reading works,
     * attributed to whichever provider answered then. That is a deliberate trade:
     * attribution can smear across a mid-conversation provider switch, which is
     * rare, in exchange for never dropping spend, which would otherwise be
     * permanent.
     */
    foldBilledUsage(tab, provider) {
        const billed = this.readBilledUsage(tab);
        if (billed === undefined)
            return;
        const delta = bucketDelta(tab.billedAtLastFold, billed);
        tab.billedAtLastFold = billed;
        if (isEmptyBuckets(delta))
            return;
        this.usage.record(provider, delta);
    }
    /**
     * `/usage`: compute the session (5h) and week (7d) rolling windows from the
     * entry log, then show the dashboard and ask each provider for its plan.
     *
     * A snapshot, the same as `/jobs` and `/mcp` are: the pane draws exactly
     * what was true the moment it opened rather than re-querying the clock on
     * every repaint, so the countdown it shows stays consistent with the
     * windows computed alongside it.
     */
    openUsageView() {
        const now = Date.now();
        const { session, week } = this.usage.windows(now);
        this.usageView.setData(session, week, this.usage.view(), now);
        this.usageView.show();
        this.picker.hide();
        this.palette.close();
        this.setStatus('');
        // The local half is drawn immediately; the provider half arrives over the
        // network, so the pane opens with what it already knows rather than holding
        // a blank screen for however long the slowest provider takes.
        this.usageView.setPlansPending();
        this.paint();
        void this.refreshPlans();
    }
    /**
     * Which routes `/usage` should ask about: every provider configured on the LLM
     * adapter that this app has a plan probe for, plus every provider the ledger
     * has already attributed a turn to.
     *
     * The union is what makes the pane complete. Configuration alone misses a route
     * reached through a stored sign-in rather than a configured key, and the ledger
     * alone misses a configured provider that simply has not been used yet — which
     * is exactly the one a user checks before starting a long job.
     */
    planRoutes() {
        const names = new Map();
        try {
            for (const provider of this.ctx.get('llm')?.listProviders() ?? []) {
                if (provider.id !== '')
                    names.set(provider.id, provider.name === '' ? provider.id : provider.name);
            }
        }
        catch {
            // A provider list this app cannot read is not a reason to show no plans:
            // the ledger still names every provider that has answered a turn.
        }
        for (const provider of this.usage.providers()) {
            if (!names.has(provider))
                names.set(provider, provider);
        }
        return [...names.entries()]
            .filter(([provider]) => hasProbe(provider))
            .map(([provider, displayName]) => ({ provider, displayName }));
    }
    /**
     * Ask every probeable route for its plan and repaint when the answers land.
     *
     * Nothing here can reject: `collectPlans` turns every per-provider failure into
     * that provider's own explanation line, so a provider being down costs one line
     * rather than the whole pane. The repaint is guarded on the pane still being
     * open, so answers arriving after the user pressed esc are simply kept for the
     * next time it opens rather than painting over whatever replaced it.
     */
    async refreshPlans() {
        // A reading less than a minute old answers immediately: reopening the pane
        // to re-check a number should not re-hit every provider. The pending
        // placeholder this replaced is painted for a frame at most.
        const cached = this.planCache.get();
        if (cached !== undefined) {
            this.usageView.setPlans(cached, Date.now());
            if (this.usageView.open)
                this.paint();
            return;
        }
        const credentials = this.ctx.get('credentials');
        if (credentials === undefined) {
            this.usageView.setPlans([], Date.now());
            if (this.usageView.open)
                this.paint();
            return;
        }
        const lookup = {
            resolveKey: async (name) => {
                try {
                    return (await credentials.resolve(credentialRef(name)))?.value;
                }
                catch {
                    return undefined;
                }
            },
            readGrantToken: async (owner, id) => {
                try {
                    const record = await credentials.readRecord(credentialKey(owner, id));
                    const payload = record?.payload;
                    if (typeof payload !== 'object' || payload === null)
                        return undefined;
                    const access = payload['access'];
                    return typeof access === 'string' && access !== '' ? access : undefined;
                }
                catch {
                    return undefined;
                }
            },
        };
        const plans = await collectPlans(this.planRoutes(), lookup);
        this.planCache.set(plans);
        this.usageView.setPlans(plans, Date.now());
        if (this.usageView.open)
            this.paint();
    }
    /**
     * Collect from this device and every configured peer.
     *
     * The pane is already on screen when this runs, so a slow or unreachable
     * peer appears as a named error under the list instead of blocking the UI.
     */
    async refreshFleet() {
        const peers = this.peers.configs();
        try {
            const sources = await collectFleet(peers);
            // The overview may have been closed while SSH was still running.
            if (!this.fleet.open)
                return;
            this.fleet.setResult(mergeFleet(sources, Date.now()), sources);
        }
        catch (error) {
            this.fleet.setResult([], []);
            this.setStatus(describeError(error), true);
        }
        this.paint();
    }
    closeFleet() {
        this.fleet.hide();
        this.setStatus('');
        this.screen.invalidate();
        this.paint();
    }
    /**
     * Act on the highlighted row.
     *
     * A session this app already owns is switched to, which is the point of the
     * list. Anything else lives in another process -- on this machine or another
     * one -- and this process has no terminal there. Rather than pretend, the
     * command that does reach it goes on the clipboard.
     */
    openFleetSelection() {
        const session = this.fleet.current();
        if (session === undefined)
            return;
        const open = this.tabs.findIndex((tab) => tab.id === session.sessionId);
        if (session.local && open !== -1) {
            this.fleet.hide();
            this.selectSession(open);
            return;
        }
        if (session.local) {
            // A local session this app does not have open — another profile's, say.
            // There is nothing over ssh to attach to, so the old fallback applies.
            this.fleet.hide();
            this.copyJumpCommand(session);
            return;
        }
        this.fleet.hide();
        void this.attachRemoteSession(session);
    }
    /** The old behavior: hand over the command instead of running it. */
    copyJumpCommand(session) {
        const command = jumpCommand(session);
        const result = this.writeClipboard(command);
        this.setStatus(result.ok ? `copied: ${command}` : `run: ${command}`);
        this.screen.invalidate();
        this.paint();
    }
    /**
     * Hand the terminal to a real `ssh -t` running the remote profile, so a
     * remote session is driven exactly like a local one — the same keys, the
     * same screen — instead of read off a copied command in another window.
     *
     * Mirrors {@link editDraft} via {@link withTerminalHandedOver}: the
     * alternate screen is given up for the duration and repainted on return.
     * Falls back to the old copy-to-clipboard behavior when this process is not
     * attached to a real terminal on both ends, since there is then nothing to
     * hand over.
     */
    async attachRemoteSession(session) {
        if (!Screen.isInteractive()) {
            this.copyJumpCommand(session);
            return;
        }
        let spawnError;
        const code = await this.withTerminalHandedOver(() => new Promise((resolve) => {
            const child = spawn('ssh', jumpArgv(session), { stdio: 'inherit' });
            child.on('error', (error) => {
                spawnError = describeError(error);
                resolve(-1);
            });
            child.on('exit', (exitCode) => resolve(exitCode ?? 0));
        }));
        if (code === 0) {
            this.setStatus(`back from ${session.host}`);
            this.paint();
            return;
        }
        // Whatever the remote side printed — a stack trace, "command not found",
        // a session the store no longer has — was written straight to this
        // terminal while ssh had it, and then erased the instant the screen
        // cleared to repaint this app's own frame. A one-line status cannot carry
        // that back, so the overlay offers the exact command to run outside this
        // app instead, where nothing will clear it away mid-read.
        this.showOverlay([
            `**Could not attach to ${session.host}**`,
            '',
            spawnError !== undefined
                ? `\`ssh\` did not start: ${spawnError}`
                : `The remote command exited with status ${String(code)}.`,
            '',
            'Its own output was on screen for a moment but is gone now — run the',
            'same command in a plain terminal to read it in full:',
            '',
            `\`${jumpCommand(session)}\``,
        ].join('\n'), 'esc to close');
    }
    handleFleetKey(key) {
        // While the prompt is up it owns the keyboard, or typing "r" into a host
        // name would refresh the list instead.
        if (this.fleet.adding) {
            this.handleFleetPromptKey(key);
            return;
        }
        switch (key.name) {
            case 'esc':
            case 'ctrl+c':
            case 'q':
                this.closeFleet();
                break;
            case 'up':
            case 'ctrl+p':
            case 'k':
                this.fleet.move(-1);
                this.paint();
                break;
            case 'down':
            case 'ctrl+n':
            case 'j':
                this.fleet.move(1);
                this.paint();
                break;
            case 'r':
                this.fleet.loading = true;
                this.paint();
                void this.refreshFleet();
                break;
            case 'a':
                this.fleet.beginAdd();
                this.setStatus('');
                this.paint();
                break;
            case 'x':
            case 'delete': {
                // Only a remote row names a peer; this device is not one of them.
                const row = this.fleet.current();
                if (row === undefined || row.local) {
                    this.setStatus('select another device to remove it from the fleet');
                    this.paint();
                    break;
                }
                if (this.removePeer(row.host)) {
                    this.setStatus(`removed ${row.host} from the fleet`);
                    this.fleet.loading = true;
                    this.paint();
                    void this.refreshFleet();
                }
                else {
                    this.setStatus(`${row.host} was not added here, so it cannot be removed`);
                    this.paint();
                }
                break;
            }
            case 'enter':
                this.openFleetSelection();
                break;
            case 'p':
                void this.previewFleetSelection();
                break;
            case 'd': {
                const row = this.fleet.current();
                if (row === undefined || row.local) {
                    this.setStatus('select another device to dispatch to it');
                    this.paint();
                    break;
                }
                const draft = this.composer.value().trim();
                if (draft === '') {
                    this.setStatus('type the task in the composer, then press d here');
                    this.paint();
                    break;
                }
                void this.dispatchTo(row.host, draft);
                break;
            }
            default:
                break;
        }
    }
    /** The `/usage` dashboard is read-only: esc/ctrl+c/q are the only keys it answers to. */
    handleUsageKey(key) {
        switch (key.name) {
            case 'esc':
            case 'ctrl+c':
            case 'q':
                this.usageView.hide();
                this.paint();
                break;
            default:
                break;
        }
    }
    /**
     * Run a task on a peer's headless profile over the SSH channel.
     *
     * The peer answers one task and exits, so this is dispatch rather than
     * attach: the result comes back as an overlay and the session it left behind
     * is the peer's to resume. The prompt is quoted for the remote shell by
     * {@link dispatchArgv}, and BatchMode forbids an interactive password prompt
     * from swallowing the terminal.
     */
    async dispatchTo(device, task) {
        if (!isValidPeer(device)) {
            this.setStatus(`${device} is not a usable host`, true);
            this.paint();
            return;
        }
        const profile = this.config.dispatchProfile ?? 'headless';
        this.setStatus(`dispatching to ${device}…`);
        this.paint();
        const result = await new Promise((resolve) => {
            const child = spawn('ssh', dispatchArgv(device, profile, task), {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            const out = [];
            const err = [];
            const timer = setTimeout(() => {
                child.kill();
                resolve({ ok: false, out: 'timed out after 10 minutes' });
            }, 600_000);
            child.stdout?.on('data', (chunk) => out.push(chunk));
            child.stderr?.on('data', (chunk) => err.push(chunk));
            child.on('error', (error) => {
                clearTimeout(timer);
                resolve({ ok: false, out: error.message });
            });
            child.on('exit', (code) => {
                clearTimeout(timer);
                const stdout = Buffer.concat(out).toString('utf8');
                const stderr = Buffer.concat(err).toString('utf8');
                resolve({
                    ok: code === 0,
                    out: stdout.trim() === '' ? stderr.trim() : stdout.trim(),
                });
            });
        });
        // A dispatch outlives attention the same way a background job does, so
        // its arrival gets the same bell a finished turn gets.
        this.tabStrip.ring();
        const body = result.out === '' ? '(no output)' : result.out.slice(-8000);
        this.showOverlay(`**${device}** · \`${profile}\`\n\n${body}`, result.ok ? 'esc to close' : 'the peer reported a failure · esc to close');
    }
    /**
     * Preview a peer session's transcript, read over the SSH channel that
     * already exists.
     *
     * The log is fetched read-only and decoded locally, so nothing on the peer
     * is written, nothing new listens, and a peer on an older format simply
     * shows the messages both formats share. The paths are built with the same
     * segment encoder the store uses, which is what makes a hostile presence
     * record unable to escape its own session directory.
     */
    async previewFleetSelection() {
        const row = this.fleet.current();
        if (row === undefined)
            return;
        if (row.local) {
            this.setStatus('this is this device — the session is on screen here');
            this.paint();
            return;
        }
        const sessionId = row.sessionId;
        if (sessionId === '') {
            this.setStatus('that row carries no session id to read');
            this.paint();
            return;
        }
        const cwd = row.cwd ?? '';
        const relative = join('sessions', cwd === '' ? '--' : projectKey(cwd), encodeSegment(sessionId));
        const remote = `sh -lc 'd="\${DSH_HOME:-$HOME/.dsh}"; cat "$d"/` +
            `${relative}/session.v*.jsonl* 2>/dev/null'`;
        this.setStatus(`reading ${sessionId} from ${row.host}…`);
        this.paint();
        const raw = await new Promise((resolve) => {
            const child = spawn('ssh', ['-o', 'BatchMode=yes', row.host, remote], {
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            const chunks = [];
            const timer = setTimeout(() => {
                child.kill();
                resolve(undefined);
            }, 15_000);
            child.stdout?.on('data', (chunk) => chunks.push(chunk));
            child.on('error', () => {
                clearTimeout(timer);
                resolve(undefined);
            });
            child.on('exit', () => {
                clearTimeout(timer);
                resolve(Buffer.concat(chunks));
            });
        });
        if (raw === undefined || raw.byteLength === 0) {
            this.setStatus(`nothing readable came back from ${row.host}`, true);
            this.paint();
            return;
        }
        const decoded = decodeLogBytes(new Uint8Array(raw));
        if (decoded === undefined) {
            this.setStatus('that log is compressed and this Node cannot decode it', true);
            this.paint();
            return;
        }
        const messages = parseLogMessages(decoded);
        if (messages.length === 0) {
            this.setStatus('that session has no readable messages');
            this.paint();
            return;
        }
        const tail = messages.slice(-40);
        const body = tail
            .map((message) => message.role === 'user' ? `**you**\n\n${message.text}` : message.text)
            .join('\n\n---\n\n');
        this.showOverlay(`**${row.title === '' ? sessionId : row.title}** · ${row.host}\n\n${body}`, 'read-only preview · esc to close');
    }
    handleFleetPromptKey(key) {
        switch (key.name) {
            case 'esc':
            case 'ctrl+c':
                this.fleet.cancelAdd();
                this.setStatus('');
                this.paint();
                break;
            case 'backspace':
                this.fleet.backspaceAdd();
                this.paint();
                break;
            case 'enter': {
                const draft = this.fleet.draft.trim();
                const host = this.fleet.commitAdd();
                if (host === undefined) {
                    this.setStatus(`not a usable host: ${draft}`, true);
                    this.paint();
                    break;
                }
                if (this.addPeer(host))
                    this.setStatus(`added ${host}`);
                this.fleet.loading = true;
                this.paint();
                void this.refreshFleet();
                break;
            }
            default:
                if (key.text !== '' && !key.text.includes('\n')) {
                    this.fleet.typeAdd(key.text);
                    this.paint();
                }
                break;
        }
    }
    // ------------------------------------------------------------ key handling
    handleKey(key) {
        try {
            // Any other key disarms a pending quit: ctrl+c, then a moment of
            // navigation, then ctrl+c again should open the menu, not lose the
            // session to a stale confirmation.
            if (key.name !== 'ctrl+c')
                this.lastQuitRequest = 0;
            if (this.panel !== undefined) {
                this.handlePanelKey(key);
                return;
            }
            if (this.fleet.open) {
                this.handleFleetKey(key);
                return;
            }
            if (this.usageView.open) {
                this.handleUsageKey(key);
                return;
            }
            if (this.picker.kind !== 'none') {
                this.handlePickerKey(key);
                return;
            }
            if (this.confirmState.open) {
                this.handleConfirmKey(key);
                return;
            }
            this.handleChatKey(key);
        }
        catch (error) {
            this.setStatus(describeError(error), true);
            this.paint();
        }
    }
    handleConfirmKey(key) {
        const settled = this.confirmState.settle(key.name);
        if (settled === undefined)
            return;
        // Status first, then the action: a destructive action phrases its own
        // outcome, and that is the line that must survive.
        this.setStatus(settled.outcome);
        if (settled.action !== undefined)
            settled.action();
        this.paint();
    }
    /**
     * Ask a yes/no question in the composer before a destructive action. Any
     * key but `y` cancels; the prompt sits in the composer box, where the next
     * keystroke is guaranteed to land.
     */
    confirm(prompt, action) {
        this.confirmState.ask(prompt, action);
        this.picker.hide();
        this.palette.close();
        this.setStatus('y to confirm · anything else cancels');
        this.paint();
    }
    handlePickerKey(key) {
        switch (key.name) {
            case 'ctrl+c':
                this.requestQuit();
                return;
            case 'esc':
                if (this.picker.kind === 'setup')
                    this.finishSetup();
                this.picker.hide();
                break;
            case 'x': {
                // Only the open-sessions list closes on this key; everywhere else "x"
                // is an ordinary character narrowing the query, same as any other key.
                if (this.picker.kind === 'open') {
                    const item = this.picker.current();
                    if (item !== undefined && item.id !== NEW_SESSION_ROW) {
                        const before = this.tabs.length;
                        this.closeSession(Number.parseInt(item.id, 10));
                        // Only rebuild the list once the close actually happened — the
                        // last-session guard sets a status this must not clobber.
                        if (this.tabs.length < before)
                            this.showOpenSessions();
                    }
                    break;
                }
                this.picker.key(key);
                break;
            }
            case 'enter': {
                const item = this.picker.current();
                const kind = this.picker.kind;
                this.picker.hide();
                if (item === undefined)
                    break;
                if (kind === 'models')
                    void this.switchModel(item);
                else if (kind === 'themes')
                    this.selectTheme(item.id);
                else if (kind === 'open') {
                    if (item.id === NEW_SESSION_ROW)
                        void this.newSession();
                    else
                        this.selectSession(Number.parseInt(item.id, 10));
                }
                else if (kind === 'plugins')
                    this.togglePlugin(item.id);
                else if (kind === 'panel')
                    void this.panelHost.activate(item.id);
                else if (kind === 'delete')
                    this.confirmDelete(item.id, item.title);
                else if (kind === 'rewind')
                    void this.performRewind(Number.parseInt(item.id, 10));
                else if (kind === 'stored')
                    void this.openStoredHit(item);
                else if (kind === 'lang')
                    this.selectLanguage(isLang(item.id) ? item.id : 'en');
                else if (kind === 'setup') {
                    if (item.id === 'lang')
                        void this.runCommand('lang', '');
                    else if (item.id === 'theme')
                        this.showThemes();
                    else if (item.id === 'login')
                        void this.runCommand('providers', '');
                    else if (item.id === 'voice')
                        this.setStatus('run: npm run setup-voice — then ctrl+v in the app');
                    else
                        this.finishSetup();
                }
                else if (kind === 'login')
                    this.chooseLoginEntry(item.id);
                else if (kind === 'login-method')
                    this.beginLoginWithMethod(item.id);
                else
                    void this.openSession(item.id, item.title);
                break;
            }
            default:
                // Navigation, paging and narrowing belong to the picker; this branch
                // must never fall through, or an arrow key would also activate a row.
                this.picker.key(key);
                break;
        }
        this.paint();
    }
    handleChatKey(key) {
        // Vim mode owns the composer while it is on. A panel, picker, or fleet
        // screen never reaches here, so modal editing can never eat their keys.
        if (this.vim.enabled) {
            const outcome = this.vim.handle(key.name, key.text, this.composer);
            if (outcome === 'mode' || outcome === 'handled') {
                this.history.reset();
                if (outcome === 'handled' || this.vim.normal)
                    this.setStatus('');
                this.updateAtMenu();
                this.paint();
                return;
            }
        }
        switch (key.name) {
            case 'ctrl+c':
                this.requestQuit();
                return;
            case 'esc':
                // A live microphone outranks everything else esc can dismiss: it is
                // the most modal state the app has, and the one to get out of first.
                if (this.voicePhase !== undefined)
                    this.cancelVoice();
                else if (this.selectedTurn !== undefined) {
                    this.selectedTurn = undefined;
                    this.setStatus('');
                }
                else if (this.atMenu.open) {
                    // Only the completion menu closes; the token stays for typing.
                    this.atDismissed = this.atMenu.query;
                    this.atMenu.close();
                }
                else if (this.palette.open)
                    this.palette.close();
                else if (this.overlay !== '')
                    this.overlay = '';
                else if (this.search !== undefined)
                    this.clearSearch();
                else if (this.tab.streaming)
                    this.interrupt();
                break;
            case 'enter':
                // Enter submits, wherever the draft belongs: a menu selection, a slash
                // command, a steer into a streaming turn, or a fresh prompt.
                this.submitComposer();
                break;
            case 'shift+enter':
                // Shift+Enter is the composer's carriage return, so a draft can span
                // several lines without submitting on the first one.
                this.history.reset();
                this.composer.insert('\n');
                break;
            case 'ctrl+enter': {
                // Interrupt-and-send: the redirection form of steering, the same
                // thing `/interrupt` does to whatever is already queued.
                const text = this.composer.value().trim();
                if (text === '' || text.startsWith('/') || !this.tab.streaming)
                    break;
                const prompt = this.materializePrompt();
                this.composer.reset();
                this.history.add(prompt.text);
                this.persistSoon();
                this.tab.queued.push(prompt);
                this.tab.drainQueue = true;
                this.interrupt();
                break;
            }
            case 'ctrl+j':
                // Ctrl+J is a line feed: the same newline as shift+enter, for
                // terminals that deliver it as its own control byte.
                this.history.reset();
                this.composer.insert('\n');
                break;
            case 'paste':
                // Bracketed paste arrives as one key: insert it whole, newlines and
                // all, without letting its contents trigger a menu or a submit.
                this.history.reset();
                this.composer.insert(key.text);
                break;
            case 'tab': {
                const chosen = this.palette.current();
                if (this.atMenu.open) {
                    this.acceptAtCompletion();
                    break;
                }
                if (chosen === undefined && this.completeCommandArgument()) {
                    this.paint();
                    break;
                }
                if (chosen !== undefined) {
                    this.composer.setValue(`/${chosen.name} `);
                    this.palette.close();
                }
                else if (this.tab.streaming && this.composer.value().trim() !== '') {
                    // Queue behind the running turn: enter steers, tab waits.
                    const prompt = this.materializePrompt();
                    this.composer.reset();
                    this.history.add(prompt.text);
                    this.persistSoon();
                    this.tab.queued.push(prompt);
                    this.setStatus(`${String(this.tab.queued.length)} queued — sends when the reply finishes`);
                }
                else if (this.composer.value() !== '') {
                    // A draft plus muscle-memory tab must not switch sessions under it;
                    // cycling needs an empty composer, like n/N in a search.
                    this.setStatus('tab cycles sessions on an empty composer');
                }
                else if (this.tabs.length > 1) {
                    // With no palette open and nothing typed, tab cycles sessions — the
                    // one-key form of alt+n, for moving between conversations without a
                    // chord.
                    this.selectSession((this.active + 1) % this.tabs.length);
                }
                else {
                    this.setStatus('only one session — ctrl+n opens another');
                }
                break;
            }
            case 'up':
                if (this.palette.open)
                    this.palette.move(-1);
                else if (this.atMenu.open)
                    this.atMenu.move(-1);
                else if (this.history.isRecalling() || this.composer.atFirstRow(this.innerWidth())) {
                    const recalled = this.history.recall(-1, this.composer.value());
                    if (recalled !== undefined)
                        this.composer.setValue(recalled);
                }
                else
                    this.composer.moveRow(-1, this.innerWidth());
                break;
            case 'down':
                if (this.palette.open)
                    this.palette.move(1);
                else if (this.atMenu.open)
                    this.atMenu.move(1);
                else if (this.history.isRecalling() || this.composer.atLastRow(this.innerWidth())) {
                    const recalled = this.history.recall(1, this.composer.value());
                    if (recalled !== undefined)
                        this.composer.setValue(recalled);
                }
                else
                    this.composer.moveRow(1, this.innerWidth());
                break;
            case 'ctrl+p':
                if (this.palette.open)
                    this.palette.move(-1);
                else if (this.atMenu.open)
                    this.atMenu.move(-1);
                break;
            case 'ctrl+n':
                if (this.palette.open)
                    this.palette.move(1);
                else if (this.atMenu.open)
                    this.atMenu.move(1);
                else
                    void this.runCommand('new', '');
                break;
            case 'ctrl+r':
                void this.runCommand('resume', '');
                break;
            case 'ctrl+t':
                void this.runCommand('thinking', '');
                break;
            case 'ctrl+x':
                // Compaction is a Harness command, so this is the same path as typing
                // /compact — the binding just saves the typing on a long session.
                void this.runCommand('compact', '');
                break;
            case 'ctrl+y':
                this.copyLastReply();
                break;
            case 'ctrl+f':
                this.openFleet();
                break;
            case 'ctrl+v':
                this.toggleVoice();
                break;
            case 'left':
                this.composer.left();
                break;
            case 'right':
                this.composer.right();
                break;
            case 'ctrl+left':
            case 'alt+b':
                this.composer.wordLeft();
                break;
            case 'ctrl+right':
            case 'alt+f':
                this.composer.wordRight();
                break;
            case 'home':
            case 'ctrl+a':
                this.composer.home();
                break;
            case 'end':
            case 'ctrl+e':
                this.composer.end();
                break;
            case 'backspace':
                this.composer.backspace();
                this.history.reset();
                break;
            case 'delete':
                this.composer.deleteForward();
                this.history.reset();
                break;
            case 'ctrl+w':
                this.composer.deleteWord();
                this.history.reset();
                break;
            case 'ctrl+k':
                this.composer.killToEnd();
                this.history.reset();
                break;
            // Scrolling is a first-class keyboard surface: a page, a half page, a
            // single line, and a way straight back to the newest output.
            case 'pageup':
                this.scroll(-this.pageRows());
                break;
            case 'pagedown':
                this.scroll(this.pageRows());
                break;
            case 'ctrl+u':
                // Clear the line, as every shell does.
                this.composer.reset();
                this.history.reset();
                break;
            case 'ctrl+d':
                // Delete forward — the readline pair to backspace.
                this.composer.deleteForward();
                this.history.reset();
                break;
            case 'ctrl+up':
                this.scroll(-Math.max(Math.floor(this.pageRows() / 2), 1));
                break;
            case 'ctrl+down':
                this.scroll(Math.max(Math.floor(this.pageRows() / 2), 1));
                break;
            case 'shift+up':
                this.scroll(-1);
                break;
            case 'shift+down':
                this.scroll(1);
                break;
            case 'ctrl+g':
                this.scrollToBottom();
                break;
            case 'click': {
                // The tab bar is the one region whose contents have stable, meaningful
                // extents; a click anywhere else is ignored rather than guessed at.
                // Its row comes from the layout, not from an assumption: the header
                // above it is conditional, so the bar moves.
                const cell = key.mouse;
                if (cell === undefined)
                    break;
                const index = tabClickTarget(this.snapshot(), cell);
                if (index !== undefined)
                    this.selectSession(index);
                break;
            }
            case 'wheelup':
                this.scroll(-3);
                break;
            case 'wheeldown':
                this.scroll(3);
                break;
            case 'alt+e':
                void this.editDraft();
                break;
            case 'alt+up':
                this.moveSelection(-1);
                break;
            case 'alt+down':
                this.moveSelection(1);
                break;
            case 'alt+c':
                this.copySelectedTurn();
                break;
            case 'alt+n':
                this.selectSession((this.active + 1) % this.tabs.length);
                break;
            case 'alt+p':
                this.selectSession((this.active - 1 + this.tabs.length) % this.tabs.length);
                break;
            case 'ctrl+b':
                if (this.tab.background.size === 0) {
                    this.setStatus('no background agents running');
                    break;
                }
                this.expandBackground = !this.expandBackground;
                break;
            case 'ctrl+o':
                this.expandTools = !this.expandTools;
                this.setStatus(this.expandTools ? 'showing every tool call' : 'tool calls collapsed');
                break;
            default: {
                const jump = /^alt\+([1-9])$/.exec(key.name);
                if (jump !== null) {
                    this.selectSession(Number.parseInt(jump[1] ?? '1', 10) - 1);
                    break;
                }
                // A plugin may own this key; if it does, the key is never text.
                if (key.text !== '' && this.tuiHost.dispatch(key.name))
                    break;
                if (key.text === '')
                    break;
                // With a search active and nothing typed, `n`/`N` walk the matches —
                // the same letter a pager uses — instead of inserting into the buffer.
                if (this.search !== undefined && this.composer.value() === '' && (key.name === 'n' || key.name === 'N')) {
                    this.jumpToMatch(key.name === 'n' ? 1 : -1);
                    break;
                }
                // `?` on an empty composer opens the key reference, matching the hint
                // the footer prints; otherwise it is just a question mark.
                if (key.name === '?' && this.composer.value() === '') {
                    void this.runCommand('help', '');
                    break;
                }
                this.history.reset();
                this.composer.insert(key.text);
                break;
            }
        }
        this.palette.update(this.composer.value(), this.commands());
        this.updateAtMenu();
        this.paint();
    }
    /**
     * Deliver the composer's draft wherever it belongs.
     *
     * Enter's path: a menu selection, a slash command, a steer into a streaming
     * turn, or a fresh prompt. The draft is materialized before the composer is
     * emptied, or the prompt is born blank and the transcript commits an empty
     * turn.
     */
    submitComposer() {
        const chosen = this.palette.current();
        if (chosen !== undefined) {
            const rawInput = this.composer.value().slice(1).split(' ').slice(1).join(' ');
            this.palette.close();
            this.composer.reset();
            void this.runCommand(chosen.name, rawInput);
            return;
        }
        if (this.atMenu.open) {
            // The completion menu is offering paths: submitting picks one rather
            // than sending, the same contract the command palette has.
            this.acceptAtCompletion();
            return;
        }
        const text = this.composer.value().trim();
        if (text === '')
            return;
        if (text.startsWith('/')) {
            const [head, ...rest] = text.slice(1).split(' ');
            this.composer.reset();
            void this.runCommand((head ?? '').toLowerCase(), rest.join(' '));
            return;
        }
        if (this.tab.streaming) {
            // The turn is busy: steer the prompt into it at the next step boundary
            // rather than waiting — the queued form is `tab`.
            const prompt = this.materializePrompt();
            this.composer.reset();
            this.history.add(prompt.text);
            this.persistSoon();
            void this.steer(prompt);
            return;
        }
        const prompt = this.materializePrompt();
        this.composer.reset();
        void this.sendPrompt(prompt);
    }
    /**
     * Recompute the `@` file menu from the composer and cursor.
     *
     * A plain query fuzzy-matches the workspace listing; one containing `/`
     * lists just that directory, the way a shell completes. The listing is
     * refreshed lazily by the index, so this stays cheap enough for a keystroke.
     */
    updateAtMenu() {
        const token = activeAtToken(this.composer.value(), this.composer.position());
        if (token === undefined) {
            this.atMenu.close();
            return;
        }
        let matches;
        if (isPathShaped(token.query)) {
            // `@src/tu` completes within `src/`; the query minus its last segment.
            const cut = token.query.lastIndexOf('/');
            const directory = cut === -1 ? '' : token.query.slice(0, cut);
            const fragment = cut === -1 ? token.query : token.query.slice(cut + 1);
            const listing = this.fileIndex?.listDir(directory) ?? { files: [] };
            matches = listing.files
                .filter((file) => file.path.toLowerCase().includes(fragment.toLowerCase()))
                .map((file) => ({ path: file.path, directory: file.directory }))
                .slice(0, 200);
        }
        else {
            matches = filterFiles(token.query, this.fileIndex?.list() ?? []);
        }
        this.atMenu.update(token, matches, this.atDismissed);
    }
    /** Accept the selected completion, replacing the `@` token with the path. */
    acceptAtCompletion() {
        const chosen = this.atMenu.current();
        const token = activeAtToken(this.composer.value(), this.composer.position());
        if (chosen === undefined || token === undefined) {
            this.atMenu.close();
            return;
        }
        this.atDismissed = undefined;
        this.atMenu.close();
        if (chosen.directory) {
            // Descend: keep the menu open on the directory's contents.
            const edit = acceptToken(this.composer.value(), this.composer.position(), token, `@${chosen.path}/`);
            this.composer.adopt(edit.text, edit.cursor);
            this.updateAtMenu();
            return;
        }
        const edit = acceptToken(this.composer.value(), this.composer.position(), token, chosen.path);
        if (isImagePath(chosen.path)) {
            void this.stageImage(chosen.path, token, edit);
        }
        else {
            this.composer.adopt(edit.text, edit.cursor);
        }
    }
    /**
     * Stage one picked image as a durable attachment and insert its token.
     *
     * The bytes are committed to the harness attachment store immediately, so
     * send only pairs tokens with references. Without the service — a minimal
     * profile — the path is inserted as plain text instead, which the model can
     * still read.
     */
    async stageImage(path, token, plainEdit) {
        const attachments = this.ctx.get('attachments');
        if (attachments === undefined) {
            this.composer.adopt(plainEdit.text, plainEdit.cursor);
            this.setStatus('attachment service unavailable — inserted the path instead');
            return;
        }
        const mediaType = mediaTypeOf(path);
        if (mediaType === undefined) {
            this.composer.adopt(plainEdit.text, plainEdit.cursor);
            return;
        }
        let data;
        try {
            data = new Uint8Array(await readFile(join(this.cwd, path)));
        }
        catch (error) {
            this.composer.adopt(plainEdit.text, plainEdit.cursor);
            this.setStatus(describeError(error), true);
            this.paint();
            return;
        }
        try {
            const ref = await attachments.saveImage({ data, mediaType, name: path });
            const n = this.nextImageNo;
            this.nextImageNo += 1;
            this.stagedImages.push({ n, ref });
            const edit = acceptToken(plainEdit.text.slice(0, plainEdit.cursor), plainEdit.cursor, { start: token.start }, `[Image #${String(n)} ${path}]`);
            this.composer.adopt(edit.text + plainEdit.text.slice(plainEdit.cursor), edit.cursor);
            this.setStatus(`attached ${path} ${String(ref.width)}×${String(ref.height)}`);
        }
        catch (error) {
            this.composer.adopt(plainEdit.text, plainEdit.cursor);
            this.setStatus(describeError(error), true);
        }
        this.paint();
    }
    innerWidth() {
        return Math.max(layout(this.snapshot()).contentWidth - 4, 10);
    }
    pageRows() {
        return Math.max(layout(this.snapshot()).viewportRows - 1, 1);
    }
    /**
     * Scroll the transcript. Positive `delta` moves towards the newest output.
     * Clamped to the rendered body, so holding pageup cannot drift the view into
     * empty space above the first line and then need as many presses to come back.
     */
    scroll(delta) {
        const limit = maxScrollBack(this.snapshot());
        this.tab.scrollBack = Math.min(Math.max(this.tab.scrollBack - delta, 0), limit);
    }
    /**
     * Show a document in the transcript pane, positioned at its first line.
     *
     * The transcript is anchored to the bottom because that is where new output
     * lands, but a document is read from the top — opening help on its last
     * paragraph would look like the page had already scrolled.
     */
    showOverlay(markdown, status) {
        this.overlay = markdown;
        this.tab.scrollBack = 0;
        this.paint();
        this.tab.scrollBack = maxScrollBack(this.snapshot());
        this.setStatus(status);
        this.paint();
    }
    /** Jump back to the newest output. */
    scrollToBottom() {
        this.tab.scrollBack = 0;
    }
    // ------------------------------------------------------------ persistence
    /** Write the durable state, coalescing a burst of edits into one save. */
    persistSoon() {
        if (this.persistTimer !== undefined)
            clearTimeout(this.persistTimer);
        this.persistTimer = setTimeout(() => {
            this.persistTimer = undefined;
            this.persistNow();
        }, 500);
        this.persistTimer.unref?.();
    }
    /** Write the durable state immediately, ignoring a failing backend. */
    persistNow() {
        this.persisted = assembleState({
            inputHistory: [...this.history.snapshot()],
            thinking: this.showThinking,
            theme: activeTheme(),
            lang: currentLanguage(),
            setupDone: this.persisted.setupDone,
            expandTools: this.expandTools,
            peers: this.peers.all(),
            sessions: this.openSessions(),
            activeSession: this.activeSessionIndex(),
            usage: this.usage.view(),
            usageEntries: this.usage.entriesView(),
        });
        // Synchronous on purpose: this runs on the quit path, where an async write
        // would be abandoned the moment `exit(0)` tears the process down.
        saveStateSync(this.persisted);
    }
    /**
     * The open sessions in tab order, as a restore wants them back.
     *
     * A tab whose Agent has not been adopted yet is left out: its id is the
     * `pending` placeholder or a session that was never written to the store, so
     * remembering it would only produce an entry the next launch has to discard.
     */
    openSessions() {
        return this.tabs
            .filter((tab) => tab.agent !== undefined)
            .map((tab) => ({ id: tab.id, model: tab.modelName, title: tab.title, theme: tab.theme }));
    }
    /**
     * Where the tab on screen lands in {@link TuiApp.openSessions}, which is not
     * `this.active` whenever an un-adopted tab sits in front of it.
     */
    activeSessionIndex() {
        const current = this.tabs[this.active];
        if (current?.agent === undefined)
            return 0;
        const index = this.openSessions().findIndex((session) => session.id === current.id);
        return index === -1 ? 0 : index;
    }
    // ---------------------------------------------------------------- search
    /** Start (or replace) a transcript search and jump to its first match. */
    startSearch(query) {
        const trimmed = query.trim();
        if (trimmed === '') {
            this.setStatus('usage: /find <text>', true);
            this.paint();
            return;
        }
        // Searching means the conversation, not whatever help page is open.
        this.overlay = '';
        this.searchState.start(trimmed);
        this.jumpToMatch(0);
    }
    /** Clear the search and return the status bar to its idle hint. */
    clearSearch() {
        if (!this.searchState.active)
            return;
        this.searchState.clear();
        this.setStatus('');
    }
    /** Move to another match, applying where the controller says the view lands. */
    jumpToMatch(delta) {
        const jumped = this.searchState.jump(delta, this.snapshot());
        if (jumped === undefined)
            return;
        if (jumped.kind === 'none') {
            this.setStatus(jumped.status, true);
            this.paint();
            return;
        }
        this.tab.scrollBack = jumped.scrollBack;
        this.setStatus(jumped.status);
    }
    // -------------------------------------------------------------- clipboard
    /** The last assistant answer worth copying, or undefined when none exists. */
    lastReply() {
        for (let index = this.tab.messages.length - 1; index >= 0; index -= 1) {
            const message = this.tab.messages[index];
            if (message !== undefined && message.role === 'assistant' && messageText(message).trim() !== '') {
                return message;
            }
        }
        return undefined;
    }
    /**
     * Move the transcript selection, starting at the newest turn.
     *
     * The selection is a marker, not a scroll: the turn it marks copies with
     * `alt+c`, and `esc` clears it before anything else esc can dismiss.
     */
    moveSelection(delta) {
        const next = moveSelection(this.selectedTurn, delta, this.tab.messages.length);
        if (next === undefined) {
            this.setStatus('nothing to select yet');
            this.paint();
            return;
        }
        this.selectedTurn = next;
        const message = this.tab.messages[next];
        const what = message?.role === 'user' ? 'your prompt' : 'the reply';
        this.setStatus(`${String(next + 1)}/${String(this.tab.messages.length)}: ${what} selected · alt+c copies · esc clears`);
        this.paint();
    }
    /** Copy the selected turn's text over the same OSC 52 path as `/copy`. */
    copySelectedTurn() {
        const message = this.selectedTurn === undefined ? undefined : this.tab.messages[this.selectedTurn];
        if (message === undefined) {
            this.setStatus('nothing selected — alt+↑ or alt+↓ picks a turn');
            this.paint();
            return;
        }
        const result = this.writeClipboard(messageText(message));
        if (result.ok) {
            this.setStatus(`copied the selected turn${result.truncated ? ' (truncated)' : ''}`);
        }
        else {
            this.setStatus(`copy failed: ${result.error}`, true);
        }
        this.paint();
    }
    /**
     * Copy the last reply to the system clipboard over the OSC 52 escape, the
     * only clipboard channel a terminal owns. It needs no dependency and no
     * external process, and it works over SSH and inside tmux. The terminal
     * decides the payload ceiling, so very long answers are truncated.
     */
    copyLastReply() {
        const message = this.lastReply();
        if (message === undefined) {
            this.setStatus('nothing to copy yet — ask the harness something first', true);
            this.paint();
            return;
        }
        const result = this.writeClipboard(messageText(message));
        if (result.ok) {
            this.setStatus(`copied the last reply to the clipboard${result.truncated ? ' (truncated)' : ''}`);
        }
        else {
            this.setStatus(`copy failed: ${result.error}`, true);
        }
        this.paint();
    }
    /**
     * Put text on the system clipboard over OSC 52.
     *
     * Shared by `/copy` and the fleet overview, because the escape and its
     * payload ceiling are the same problem in both places.
     */
    writeClipboard(text) {
        const { sequence, truncated } = buildOsc52(text);
        try {
            // Written directly, then the next paint redraws.
            process.stdout.write(wrapForMultiplexer(sequence, process.env));
            // OSC 52 is the only channel that survives SSH, so it is always
            // written — wrapped for tmux or GNU screen when one is in the middle,
            // since neither forwards an embedded escape sequence to the real
            // terminal on its own. It is not sufficient by itself even then: a
            // Wayland compositor only lets a window own the clipboard while it
            // holds an input-focus serial, so the escape can be well-formed,
            // accepted by the terminal, and still leave the clipboard untouched.
            // Where a local helper exists it is what actually lands, so it is used
            // as well — same text, last writer wins.
            copyWithLocalHelper(text);
            return { ok: true, truncated };
        }
        catch (error) {
            return { ok: false, truncated: false, error: describeError(error) };
        }
    }
    /**
     * Write the transcript of the active session to a markdown file.
     *
     * Without an argument the file lands in the working directory the session
     * started in, named after the moment: `dsh-transcript-20250101-120000.md`.
     */
    async exportTranscript(requested) {
        const fs = this.ctx.get('fs');
        const base = fs === undefined ? process.cwd() : fs.processPath(await fs.resolve('.'));
        const file = requested === ''
            ? join(base, `dsh-transcript-${timestampForFile()}.md`)
            : isAbsolute(requested)
                ? requested
                : resolve(base, requested);
        const markdown = transcriptMarkdown(this.tab.messages, this.tab.title);
        try {
            await writeFile(file, markdown, 'utf8');
            this.setStatus(`exported to ${file}`);
        }
        catch (error) {
            this.setStatus(`export failed: ${describeError(error)}`, true);
        }
        this.paint();
    }
    /**
     * `/update`: check npm for a newer release and install it globally.
     *
     * The check follows the configured registry (`NPM_CONFIG_REGISTRY`), so
     * mirror users see the versions their package manager actually installs.
     * Restarting is left to the user — sessions reopen on launch — because a
     * live self-restart would abandon the terminal the app is drawing in.
     */
    async selfUpdate() {
        const packageName = 'moqi';
        const registry = process.env['NPM_CONFIG_REGISTRY'] ?? 'https://registry.npmjs.org';
        this.setStatus('checking npm for a newer version…');
        this.paint();
        let latest;
        try {
            const response = await fetch(`${registry.replace(/\/+$/, '')}/${packageName}`);
            if (!response.ok)
                throw new Error(`registry answered ${String(response.status)}`);
            const body = (await response.json());
            if (typeof body['dist-tags']?.latest !== 'string')
                throw new Error('no latest tag');
            latest = body['dist-tags'].latest;
        }
        catch (error) {
            this.setStatus(`update check failed: ${describeError(error)}`, true);
            this.paint();
            return;
        }
        if (latest === VERSION) {
            this.setStatus(`already the latest version (${VERSION})`);
            this.paint();
            return;
        }
        this.setStatus(`updating to ${latest}…`);
        this.paint();
        const code = await new Promise((resolve) => {
            const child = spawn('npm', ['install', '-g', `${packageName}@${latest}`], {
                stdio: 'ignore',
            });
            child.on('error', () => resolve(1));
            child.on('exit', (exitCode) => resolve(exitCode ?? 1));
        });
        this.setStatus(code === 0
            ? `updated to ${latest} — restart dsh; your sessions reopen`
            : 'update failed — installed from a checkout? git pull and rebuild instead', code !== 0);
        this.paint();
    }
    // --------------------------------------------------------------- behaviors
    /**
     * Send a prompt and stream the reply into the transcript.
     *
     * A thin wrapper over {@link sendTo} pinned to the session on screen; the
     * queue-draining follow-up needs the tab-explicit form, because it must
     * keep writing to the conversation that queued the prompt even if the user
     * has since switched sessions.
     */
    /**
     * Collect the composer into a prompt: strip `[Image #N]` tokens and pair
     * them with their staged references. Staged images the draft no longer
     * names are dropped — deleting a token deletes the attachment.
     */
    materializePrompt() {
        const extracted = extractImageTokens(this.composer.value());
        const wanted = new Set(extracted.numbers);
        const images = this.stagedImages
            .filter((staged) => wanted.has(staged.n))
            .map((staged) => staged.ref);
        this.stagedImages = this.stagedImages.filter((staged) => wanted.has(staged.n));
        return { text: extracted.text.trim(), images };
    }
    /**
     * Steer a prompt into the turn that is still running.
     *
     * The follow-up is delivered to the agent mid-turn and lands at its next
     * step boundary; nothing is queued and nothing waits. The transcript shows
     * it dimmed, marked as steered, so the interleaving reads honestly.
     */
    async steer(prompt) {
        const agent = this.tab.agent;
        if (agent === undefined)
            return;
        this.tab.messages.push(textMessage('user', prompt.text, {
            steering: true,
            attachments: prompt.images.map((ref) => ({
                name: ref.name ?? 'image',
                width: ref.width,
                height: ref.height,
            })),
        }));
        this.scrollToBottom();
        this.setStatus('steered into the running turn');
        this.paint();
        try {
            agent.followup(createUserMessage({
                content: promptBlocks(prompt),
                source: { kind: 'user' },
            }));
        }
        catch (error) {
            this.setStatus(describeError(error), true);
            this.paint();
        }
    }
    async send(text) {
        await this.turns.send(this.tab, text);
    }
    /**
     * Round-trip the draft through `$VISUAL`/`$EDITOR`.
     *
     * {@link withTerminalHandedOver} gives the editor the terminal for the
     * duration — the alternate screen is left and the frame comes back
     * repainted on return. A non-zero exit keeps the draft untouched (the `:cq`
     * convention), and neither variable being set is a status line, not a `vi`
     * fallback nobody asked for.
     */
    async editDraft() {
        const editor = process.env['VISUAL'] ?? process.env['EDITOR'];
        if (editor === undefined || editor.trim() === '') {
            this.setStatus('set $VISUAL or $EDITOR to edit the draft outside');
            this.paint();
            return;
        }
        const file = join(tmpdir(), `moqi-draft-${String(process.pid)}.md`);
        await writeFile(file, `${this.composer.value()}\n`);
        try {
            const code = await this.withTerminalHandedOver(() => new Promise((resolve, reject) => {
                const child = spawn(editor, [file], { stdio: 'inherit' });
                child.on('error', reject);
                child.on('exit', (exitCode) => {
                    resolve(exitCode ?? 0);
                });
            }));
            if (code === 0) {
                const edited = (await readFile(file, 'utf8')).replace(/\n$/, '');
                this.composer.setValue(edited);
                this.history.reset();
                this.atMenu.close();
            }
            else {
                this.setStatus('editor exited non-zero — draft kept');
            }
        }
        catch (error) {
            this.setStatus(describeError(error), true);
        }
        finally {
            await unlink(file).catch(() => { });
            this.updateAtMenu();
            this.paint();
        }
    }
    /** Send a materialized prompt to the active session. */
    async sendPrompt(prompt) {
        await this.turns.run(this.tab, prompt);
    }
    /** Send a prompt to one specific session and stream the reply. */
    async sendTo(tab, prompt, fromQueue = false) {
        await this.turns.run(tab, prompt, fromQueue);
    }
    /** Persist the session, ignoring a backend that does not support it. */
    async flush(tab = this.tab) {
        const sessions = this.ctx.get('sessions');
        const agent = tab.agent;
        if (sessions === undefined || agent === undefined)
            return;
        try {
            await sessions.flush(agent.session);
        }
        catch {
            // A profile without persistence is a valid configuration.
        }
    }
    /** Ask the running turn to stop. */
    interrupt() {
        this.abort?.abort();
        const agent = this.tab.agent;
        try {
            agent?.interrupt?.();
            agent?.abort?.();
            this.setStatus('interrupting…');
        }
        catch (error) {
            this.setStatus(describeError(error), true);
        }
    }
    /**
     * Name the active session (`/rename <title>`), or with no argument ask the
     * title service to regenerate the automatic one. A rename pins the title in
     * the session's own durable log — a `session/title` event with the `user`
     * source — so every surface that reads titles agrees: this tab, the resume
     * picker, and any other dsh client of the same session. The tab label and
     * the restore cache follow immediately.
     */
    async renameSession(rawInput) {
        const plan = planRename(rawInput);
        const tab = this.tab;
        const agent = tab.agent;
        if (agent === undefined) {
            this.setStatus('this session has no agent yet', true);
            this.paint();
            return;
        }
        const titles = this.ctx.get('sessionTitle');
        if (titles?.rename === undefined || titles.refresh === undefined) {
            this.setStatus('this profile has no session title service', true);
            this.paint();
            return;
        }
        try {
            if (plan.kind === 'pin') {
                const snapshot = titles.rename(agent.session, plan.title);
                // The service normalized the text; the tab label keeps the same
                // 60-character budget as the automatic first-prompt title.
                const title = (snapshotTitle(snapshot) ?? plan.title).slice(0, 60);
                tab.title = title;
                this.persistSoon();
                this.setStatus(`renamed → ${title}`);
            }
            else {
                const snapshot = await titles.refresh(agent.session);
                const title = snapshotTitle(snapshot);
                if (title === undefined) {
                    this.setStatus('no automatic title yet — send something first');
                }
                else {
                    tab.title = title.slice(0, 60);
                    this.persistSoon();
                    this.setStatus(`title → ${tab.title}`);
                }
            }
        }
        catch (error) {
            this.setStatus(describeError(error), true);
        }
        this.paint();
    }
    /** Run a slash command: this app's own first, then the Harness registry. */
    async runCommand(name, rawInput) {
        this.tab.scrollBack = 0;
        switch (name) {
            case 'new':
                await this.newSession();
                return;
            case 'resume':
                await this.showSessions();
                return;
            case 'delete':
                await this.showSessions('delete');
                return;
            case 'rename':
                await this.renameSession(rawInput);
                return;
            case 'sessions':
                this.showOpenSessions();
                return;
            case 'close':
                this.closeSession(this.active);
                return;
            case 'model': {
                if (rawInput.trim() === '')
                    await this.showModels();
                else
                    await this.selectModelByName(rawInput.trim());
                return;
            }
            case 'theme': {
                if (rawInput.trim() === '')
                    this.showThemes();
                else
                    this.selectTheme(rawInput.trim());
                return;
            }
            case 'plugins':
                this.handlePluginsInput(rawInput.trim());
                return;
            case 'thinking':
                this.showThinking = !this.showThinking;
                this.persistSoon();
                this.setStatus(this.showThinking ? 'showing reasoner thinking' : 'hiding reasoner thinking');
                this.paint();
                return;
            case 'find': {
                const words = rawInput.trim().split(/\s+/).filter((word) => word !== '');
                if (words[0] === '--sessions' || words[0] === '-s') {
                    this.searchStoredSessions(words.slice(1).join(' '));
                    return;
                }
                this.startSearch(rawInput);
                return;
            }
            case 'unqueue': {
                const count = this.tab.queued.length;
                this.tab.queued = [];
                this.setStatus(count === 0
                    ? 'nothing queued'
                    : `cleared ${String(count)} queued message${count === 1 ? '' : 's'}`);
                this.paint();
                return;
            }
            case 'rewind':
                this.showRewind();
                return;
            case 'fork':
                void this.performFork();
                return;
            case 'tree':
                void this.showTree();
                return;
            case 'jobs':
                this.showJobs(rawInput);
                return;
            case 'mcp':
                this.showMcp();
                return;
            case 'dispatch': {
                const words = rawInput.trim().split(/\s+/).filter((word) => word !== '');
                const device = words.shift();
                const task = words.join(' ');
                if (device === undefined || task === '') {
                    this.setStatus('usage: /dispatch <device> <task>', true);
                    this.paint();
                    return;
                }
                void this.dispatchTo(device, task);
                return;
            }
            case 'lang': {
                const wanted = rawInput.trim();
                if (wanted === '') {
                    // The base a cancelled preview returns to; see syncPickerPreview.
                    this.previewBaseLang = currentLanguage();
                    this.picker.show('lang', 'Language', LANGS.map((entry) => ({
                        id: entry.id,
                        title: entry.label,
                        subtitle: entry.id,
                        active: entry.id === currentLanguage(),
                    })));
                    this.setStatus('');
                }
                else if (isLang(wanted)) {
                    this.selectLanguage(wanted);
                }
                else {
                    this.setStatus(`unknown language ${wanted} — try en or zh-CN`, true);
                }
                this.paint();
                return;
            }
            case 'providers': {
                const auth = this.ctx.get('authorization');
                if (auth === undefined) {
                    this.setStatus('this profile has no authorization service', true);
                    this.paint();
                    return;
                }
                const entries = auth.list();
                if (entries.length === 0) {
                    this.setStatus('nothing here can be signed into — mount a plugin that offers a login', true);
                    this.paint();
                    return;
                }
                this.loginEntries = entries;
                this.picker.show('login', 'Sign in', entries.map((entry, index) => ({
                    id: String(index),
                    title: entry.label,
                    subtitle: entry.inFlight
                        ? 'already signing in…'
                        : entry.methods.map((method) => method.label).join(' · '),
                })));
                this.setStatus('');
                this.paint();
                return;
            }
            case 'interrupt': {
                // Two ways to stop a reply. `esc` is a bid for silence: the queue
                // freezes until the user sends again. `/interrupt` is a redirection:
                // stop this answer, then push the queued prompts into the loop.
                if (!this.tab.streaming) {
                    this.setStatus('nothing is streaming');
                    this.paint();
                    return;
                }
                this.tab.drainQueue = true;
                this.setStatus(this.tab.queued.length > 0
                    ? `interrupting — ${String(this.tab.queued.length)} queued will run`
                    : 'interrupting…');
                this.interrupt();
                return;
            }
            case 'copy':
                this.copyLastReply();
                return;
            case 'export':
                await this.exportTranscript(rawInput.trim());
                return;
            case 'fleet':
                this.openFleet();
                return;
            case 'peer': {
                const [verb = '', ...rest] = rawInput.trim().split(/\s+/);
                const host = rest.join(' ').trim();
                if (verb === '') {
                    this.setStatus(this.peers.all().length === 0
                        ? 'no devices yet — /peer add <host>, or press a in the fleet'
                        : `fleet devices: ${this.peers.all().join(', ')}`);
                }
                else if (verb === 'add') {
                    if (this.addPeer(host))
                        this.setStatus(`added ${host} — ctrl+f to see it`);
                }
                else if (verb === 'rm' || verb === 'remove') {
                    this.setStatus(this.removePeer(host) ? `removed ${host}` : `${host} is not in the fleet`, !this.peers.has(host) && host === '');
                }
                else {
                    this.setStatus('usage: /peer [add|rm <host>]', true);
                }
                this.paint();
                return;
            }
            case 'update':
                void this.selfUpdate();
                return;
            case 'tools': {
                const tools = this.ctx.get('tools');
                let listed = [];
                try {
                    const raw = tools?.list?.() ?? [];
                    listed = raw.map((tool) => String(tool.name ?? '')).filter((tool) => tool !== '');
                }
                catch {
                    listed = [];
                }
                this.showOverlay(listed.length === 0
                    ? '**Tools**\n\nThis profile exposes no tool registry to the app.'
                    : `**Tools**\n\n${listed.map((tool) => `- \`${tool}\``).join('\n')}`, 'esc to close');
                return;
            }
            case 'usage': {
                if (rawInput.trim() === 'reset') {
                    this.usage.clear();
                    this.usageView.hide();
                    this.persistSoon();
                    this.setStatus('usage ledger reset');
                    this.paint();
                    return;
                }
                this.openUsageView();
                return;
            }
            case 'help':
                this.showOverlay(keyReference(), 'esc to close help');
                return;
            case 'exit':
            case 'quit':
                this.quit();
                return;
            default:
                break;
        }
        // Anything else belongs to the Harness command registry.
        const registry = this.ctx.get('commands');
        const agent = this.tab.agent;
        if (registry === undefined || agent === undefined) {
            // A plugin panel is the last stop before "unknown": it may claim a name
            // the app and the Harness registry both leave free, never one they use.
            if (this.panelHost.openByName(name))
                return;
            this.setStatus(`unknown command /${name} — type / to see them`, true);
            this.paint();
            return;
        }
        const line = rawInput.trim() === '' ? `/${name}` : `/${name} ${rawInput}`;
        this.setStatus(`running /${name}…`);
        this.paint();
        try {
            // execute() takes a required AbortSignal and reads .aborted on it.
            // Passing undefined threw "Cannot read properties of undefined" out of
            // the registry, which surfaced as every Harness command failing --
            // /permission, /plan, /goal -- with an error that named nothing useful.
            const controller = new AbortController();
            const execution = await registry.execute(agent, line, [], controller.signal);
            if (execution === undefined) {
                if (this.panelHost.openByName(name))
                    return;
                this.setStatus(`unknown command /${name} — type / to see them`, true);
                this.paint();
                return;
            }
            const result = execution.result ?? execution;
            const okResult = String(result.kind ?? 'success') === 'success';
            const text = String(result.text ?? '');
            this.tab.messages.push(textMessage('assistant', text === '' ? (okResult ? 'done' : 'failed') : text, {
                command: { name, ok: okResult },
            }));
            this.setStatus(okResult ? '' : `/${name} failed`, !okResult);
            // A command can rewrite history (compaction does), so re-read it.
            if (this.tab.agent !== undefined)
                this.refreshFromSession();
            void this.flush();
        }
        catch (error) {
            this.setStatus(describeError(error), true);
        }
        this.paint();
    }
    /** Replace the transcript with a fresh agent and session. */
    async newSession() {
        const agents = this.ctx.get('agents');
        const defaultModel = this.ctx.get('agentDefaultModel');
        if (agents === undefined || defaultModel === undefined)
            return;
        this.setStatus('starting a new session\u2026');
        this.paint();
        // A new session starts from whatever model the session it was opened from
        // is using — it should not silently revert to the stored default the user
        // just switched away from — but with its OWN selection ref, so later
        // switches in either conversation leave the other alone.
        const seed = this.tab.selection.current ?? defaultModel.currentSelection();
        const fs = this.ctx.get('fs');
        const cwd = fs === undefined ? process.cwd() : fs.processPath(await fs.resolve('.'));
        const sessionId = brandString(`session-${randomUUID()}`);
        const tab = newTab(String(sessionId));
        tab.selection.current = seed;
        tab.modelName = String(seed.model);
        // Same rule as the model just above: the theme of the conversation it was
        // opened from, not the stored default, then diverges independently.
        tab.theme = this.tab.theme;
        try {
            const created = await agents.create({
                sessionId,
                meta: { cwd },
                agentOptions: { provider: seed.provider, model: seed.model },
                setup: this.selectionSetupFor(tab),
            });
            await created.agent.whenIdle();
            // A new session is an additional one: the conversation that was open
            // keeps running, and its reply will still arrive and ring.
            tab.agent = created.agent;
            this.adoptForeground(tab);
            this.tabs.push(tab);
            this.active = this.tabs.length - 1;
            this.persistSoon();
            this.overlay = '';
            this.composer.reset();
            this.setStatus(this.tabs.length > 1 ? `session ${String(this.tabs.length)}` : 'new session');
            this.screen.invalidate();
            void this.refreshContextLimit(tab);
        }
        catch (error) {
            this.setStatus(describeError(error), true);
        }
        this.paint();
    }
    /**
     * `/rewind` — pick an earlier prompt, then redo it in a forked session.
     *
     * The fork keeps every completed turn before that prompt, and the prompt
     * itself returns to the composer for editing: the original session is never
     * touched, so nothing is lost by trying a different direction.
     */
    showRewind() {
        const session = this.tab.agent?.session;
        if (session === undefined) {
            this.setStatus('no session to rewind', true);
            this.paint();
            return;
        }
        const turns = projectUserTurns(sessionEvents(session));
        const items = [];
        turns.forEach((turn, index) => {
            const first = turn.text.split('\n')[0] ?? '';
            items.push({
                id: String(index),
                title: first.length > 60 ? `${first.slice(0, 59)}…` : first,
                subtitle: index === 0
                    ? 'first prompt — cannot rewind past it'
                    : `${String(index + 1)} of ${String(turns.length)}`,
            });
        });
        if (items.length === 0) {
            this.setStatus('nothing to rewind yet');
            this.paint();
            return;
        }
        this.picker.show('rewind', 'Rewind to a prompt', items);
        this.setStatus('enter forks the session at that point · esc cancels');
        this.paint();
    }
    /** Fork at the chosen prompt's turn boundary and restore it to the composer. */
    async performRewind(chosenIndex) {
        const session = this.tab.agent?.session;
        if (session === undefined)
            return;
        const target = rewindTarget(projectUserTurns(sessionEvents(session)), chosenIndex);
        if (target === undefined) {
            this.setStatus('cannot rewind past the first prompt — /fork copies the whole conversation');
            this.paint();
            return;
        }
        await this.interruptAndSettle();
        const forked = await this.forkAt(target.cutSeq);
        if (forked === undefined)
            return;
        this.composer.setValue(target.text);
        this.history.reset();
        this.setStatus(`rewound — edit the prompt and press enter (${String(target.cutSeq)} events kept)`);
        this.paint();
    }
    /** `/fork` — copy the whole conversation into a twin. */
    async performFork() {
        const session = this.tab.agent?.session;
        if (session === undefined)
            return;
        const cut = forkCut(sessionEvents(session), session.seq);
        if (cut === 0) {
            this.setStatus('nothing to fork yet — send a prompt first');
            this.paint();
            return;
        }
        await this.interruptAndSettle();
        const forked = await this.forkAt(cut);
        if (forked !== undefined) {
            this.setStatus(`forked — ${String(cut)} events inherited, the original is untouched`);
            this.paint();
        }
    }
    /**
     * Create a new session seeded with the current log's first `cut` events.
     *
     * The Harness validates the seed at its own boundary: a prefix that ends
     * mid-turn or carries a dangling tool call is rejected there, which is why
     * the callers compute turn boundaries rather than guessing.
     */
    async forkAt(cut) {
        const agents = this.ctx.get('agents');
        const session = this.tab.agent?.session;
        if (agents === undefined || session === undefined)
            return undefined;
        const seed = session.snapshotEvents(SessionLogOffset(0), SessionLogOffset(cut));
        const carried = this.tab.selection.current;
        const sessionId = brandString(`session-${randomUUID()}`);
        const tab = newTab(String(sessionId));
        tab.theme = this.tab.theme;
        if (carried !== undefined) {
            tab.selection.current = carried;
            tab.modelName = String(carried.model);
        }
        try {
            const created = await agents.create({
                sessionId,
                meta: { cwd: this.cwd, parentSession: session.header.id, isSeeded: true },
                inheritedEventCount: SessionLogOffset(cut),
                seed,
                agentOptions: carried === undefined
                    ? undefined
                    : { provider: carried.provider, model: carried.model },
                setup: this.selectionSetupFor(tab),
            });
            tab.agent = created.agent;
            this.adoptForeground(tab);
            this.tabs.push(tab);
            this.active = this.tabs.length - 1;
            tab.messages = readHistory(created.agent.session);
            this.persistSoon();
            this.overlay = '';
            this.screen.invalidate();
            void this.refreshContextLimit(tab);
            return tab;
        }
        catch (error) {
            this.setStatus(`fork failed: ${describeError(error)}`, true);
            this.paint();
            return undefined;
        }
    }
    /** `/tree` — the fork family this session belongs to, oldest first. */
    async showTree() {
        const open = this.tabs
            .filter((tab) => tab.agent !== undefined)
            .map((tab) => ({ id: tab.id, title: tab.title, parentSession: parentOf(tab.agent?.session) }));
        const query = this.ctx.get('sessionQuery');
        let stored = [];
        if (query !== undefined) {
            try {
                stored = (await listSessionsWithParents(query)).map((row) => ({
                    id: row.id,
                    title: row.title,
                    parentSession: row.parentSession,
                }));
            }
            catch {
                stored = [];
            }
        }
        const known = [...open, ...stored];
        const path = lineage(known, this.tab.id);
        const lines = path.map((node, index) => {
            const title = node.title === undefined || node.title === '' ? node.id : node.title;
            const mark = node.id === this.tab.id ? '●' : '○';
            return `${'  '.repeat(index)}${mark} ${title}`;
        });
        const children = known.filter((node) => node.parentSession === this.tab.id);
        this.showOverlay([
            '**Session tree**',
            '',
            ...(lines.length > 0 ? lines : ['(no lineage recorded)']),
            '',
            children.length === 0
                ? 'No forks of this session yet — `/rewind` or `/fork` creates one.'
                : `Forks of this session: ${String(children.length)}`,
        ].join('\n'), 'esc to close');
    }
    /**
     * `/find --sessions <text>` — search every stored session on this machine.
     *
     * The store is read-only here: hits are shown in a picker and opening one
     * resumes that session, so a search can never disturb a log another process
     * is still appending to.
     */
    searchStoredSessions(query) {
        if (query.trim() === '') {
            this.setStatus('usage: /find --sessions <text>', true);
            this.paint();
            return;
        }
        this.setStatus('searching stored sessions…');
        this.paint();
        const result = searchSessions(sessionsRoot(), query);
        if (result.hits.length === 0) {
            const note = result.skippedCompressed > 0
                ? ` (${String(result.skippedCompressed)} compressed logs need a newer Node)`
                : '';
            this.setStatus(`no stored session mentions that${note}`, true);
            this.paint();
            return;
        }
        this.storedHits = result.hits;
        this.picker.show('stored', `Stored sessions: ${String(result.hits.length)} hits in ${String(result.scanned)} logs`, result.hits.map((hit, index) => ({
            id: String(index),
            title: hit.line,
            subtitle: `${hit.role === 'user' ? 'you' : 'model'} · ${hit.project} · ${hit.sessionId.slice(-8)}`,
        })));
        this.setStatus('enter opens that session · esc cancels');
        this.paint();
    }
    /** Resume the session a stored-search hit came from. */
    async openStoredHit(item) {
        const hit = this.storedHits[Number.parseInt(item.id, 10)];
        if (hit === undefined)
            return;
        await this.openSession(hit.sessionId, hit.project);
    }
    /** Switch the interface language and remember it across restarts. */
    selectLanguage(lang) {
        // Committing a language is the one preview exit that must not restore.
        this.previewBaseLang = undefined;
        setLanguage(lang);
        this.persisted.lang = lang;
        this.persistSoon();
        this.screen.invalidate();
        this.setStatus(lang === 'zh-CN' ? '界面语言：简体中文' : 'interface language: English');
        this.paint();
    }
    // ------------------------------------------------------------------ login
    /** `enter` on the `/providers` list: the flow picks the entry, then the method. */
    chooseLoginEntry(id) {
        this.loginFlow.chooseEntry(this.loginEntries, id);
    }
    /** `enter` on the method picker a multi-method flow opened. */
    beginLoginWithMethod(methodId) {
        this.loginFlow.beginWithMethod(methodId);
    }
    /**
     * `/mcp` — which MCP servers' tools this profile actually mounted.
     *
     * The MCP client is composition-level, so the view is honest: it reports the
     * tools whose names carry a bridge prefix and tells the user where servers
     * are declared, rather than pretending to add or remove them at runtime.
     */
    showMcp() {
        let names = [];
        const tools = this.ctx.get('tools');
        try {
            names = (tools?.list?.() ?? [])
                .map((tool) => String(tool.name ?? ''))
                .filter((name) => name !== '');
        }
        catch {
            names = [];
        }
        this.showOverlay(renderMcp(groupMcpTools(names), names.length), 'esc to close');
    }
    /**
     * Keep the pickers that preview on highlight in step with the screen.
     *
     * The themes picker repaints the whole app in the highlighted palette as
     * the cursor moves — browsing 21 palettes by arrow key is the whole point
     * of having them — and the language picker re-renders the chrome in the
     * highlighted language for the same reason. Both are previews, not
     * choices: nothing persists, per-tab bookkeeping is untouched, and leaving
     * the picker without committing restores what was in force before it
     * opened. A commit clears the base itself, so the restore here can be
     * unconditional.
     */
    syncPickerPreview() {
        if (this.picker.kind === 'themes') {
            const item = this.picker.current();
            if (item !== undefined && item.id !== activeTheme()) {
                applyTheme(item.id);
                this.screen.invalidate();
            }
            return;
        }
        if (this.picker.kind === 'lang') {
            const item = this.picker.current();
            if (item !== undefined && isLang(item.id) && item.id !== currentLanguage()) {
                setLanguage(item.id);
                this.screen.invalidate();
            }
            return;
        }
        if (this.previewBaseTheme !== undefined) {
            if (activeTheme() !== this.previewBaseTheme) {
                applyTheme(this.previewBaseTheme);
                this.screen.invalidate();
            }
            this.previewBaseTheme = undefined;
        }
        if (this.previewBaseLang !== undefined) {
            if (currentLanguage() !== this.previewBaseLang)
                setLanguage(this.previewBaseLang);
            this.previewBaseLang = undefined;
        }
    }
    /**
     * Tab completion for the arguments of the commands whose values the app
     * already enumerates: `/theme <tab>`, `/lang <tab>`.
     *
     * An unambiguous match completes in place; an ambiguous one extends to the
     * shared prefix and then, pressed again, opens the picker the command
     * itself opens — completion and browsing should end in the same place.
     * Returns whether the tab was consumed, so the ordinary meanings of the
     * key are untouched for every other input.
     */
    completeCommandArgument() {
        const text = this.composer.value();
        if (!text.startsWith('/') || text.includes('\n'))
            return false;
        const space = text.indexOf(' ');
        if (space === -1)
            return false;
        const command = text.slice(1, space);
        const argument = text.slice(space + 1);
        if (argument.includes(' '))
            return false;
        let candidates = [];
        let open;
        if (command === 'theme') {
            candidates = listThemes().map((theme) => theme.name);
            open = () => this.showThemes();
        }
        else if (command === 'lang') {
            candidates = LANGS.map((entry) => entry.id);
            open = () => void this.runCommand('lang', '');
        }
        else {
            return false;
        }
        const matches = candidates.filter((name) => name.startsWith(argument));
        if (matches.length === 1 && matches[0] !== argument) {
            this.composer.setValue(`/${command} ${String(matches[0])} `);
            this.setStatus('');
            return true;
        }
        if (matches.length > 1) {
            const prefix = matches.reduce((shared, name) => {
                let end = 0;
                while (end < shared.length && end < name.length && shared[end] === name[end])
                    end += 1;
                return shared.slice(0, end);
            });
            if (prefix.length > argument.length) {
                this.composer.setValue(`/${command} ${prefix}`);
                return true;
            }
            open?.();
            return true;
        }
        if (matches.length === 0) {
            this.setStatus(`no ${command === 'theme' ? 'palette' : 'language'} starts with ${argument}`);
        }
        return matches.length !== 0;
    }
    /**
     * Watch the background-job registry and announce finishes.
     *
     * A job outliving the user's attention is the normal case — that is what
     * running it in the background means — so the app says so with the same
     * bell a finished turn uses, plus a status line, the moment a job that was
     * running is seen finished. Only observed transitions announce: a job that
     * was already finished when the app started (or that this profile's
     * registry lists without ever having run) stays quiet.
     */
    watchJobs() {
        const registry = this.ctx.get('jobs');
        if (registry === undefined)
            return;
        let jobs;
        try {
            jobs = registry.list(this.tab.agent);
        }
        catch {
            return;
        }
        for (const job of jobs) {
            if (typeof job.status !== 'string')
                continue;
            const id = String(job.id);
            const previous = this.jobStatus.get(id);
            if (job.status === 'running') {
                this.jobStatus.set(id, 'running');
                continue;
            }
            if (previous === 'running') {
                this.jobStatus.set(id, job.status);
                const label = typeof job.label === 'string' ? job.label : '';
                this.tabStrip.ring();
                this.setStatus(`background job ${label === '' ? id : label} finished`);
                this.paint();
            }
            else if (previous === undefined) {
                this.jobStatus.set(id, job.status);
            }
        }
    }
    /**
     * `/jobs` — what ran or is running in the background, and how to stop one.
     *
     * The registry is scoped to the agent that owns each job, so the list is the
     * current session's jobs plus whatever it delegated.
     */
    showJobs(requested) {
        const registry = this.ctx.get('jobs');
        if (registry === undefined) {
            this.setStatus('this profile composes no background job registry', true);
            this.paint();
            return;
        }
        const words = requested.trim().split(/\s+/).filter((word) => word !== '');
        if (words[0] === 'kill') {
            const id = words[1];
            if (id === undefined) {
                this.setStatus('usage: /jobs kill <id>', true);
                this.paint();
                return;
            }
            try {
                const outcome = registry.kill(id, this.tab.agent);
                this.setStatus(outcome === 'requested' ? `stopping ${id}` : `${id} had already finished`);
            }
            catch (error) {
                this.setStatus(describeError(error), true);
            }
            this.paint();
            return;
        }
        let jobs = [];
        try {
            jobs = registry.list(this.tab.agent).map((job) => ({
                id: String(job.id),
                kind: String(job.kind),
                label: job.label,
                status: job.status,
                detail: job.detail,
                startedAt: job.startedAt,
                finishedAt: job.finishedAt,
            }));
        }
        catch (error) {
            this.setStatus(describeError(error), true);
            this.paint();
            return;
        }
        this.showOverlay(renderJobs(jobs), 'esc to close');
    }
    /**
     * Stop a running turn and wait for it to settle, capped, before forking.
     *
     * A fork that lands while the loop is still appending would inherit a
     * half-finished turn; the cap keeps an unresponsive turn from hanging the
     * command forever.
     */
    async interruptAndSettle() {
        const tab = this.tab;
        if (!tab.streaming)
            return;
        this.setStatus('stopping the running reply…');
        this.paint();
        this.interrupt();
        await Promise.race([
            tab.agent?.whenIdle() ?? Promise.resolve(),
            new Promise((resolve) => setTimeout(resolve, 30_000)),
        ]);
    }
    /**
     * Every model the mounted adapters can serve, as picker rows. A provider
     * whose listing fails (an unreachable gateway, a missing credential) is
     * skipped rather than failing the whole list, so one broken route does not
     * hide the working ones.
     */
    async listModelRows() {
        const llm = this.ctx.get('llm');
        if (llm === undefined)
            return [];
        const rows = [];
        for (const provider of llm.listProviders()) {
            let models = [];
            try {
                models = await llm.listModels(provider.id);
            }
            catch {
                continue;
            }
            for (const model of models) {
                rows.push({
                    id: `${provider.id}/${model.id}`,
                    title: model.name === '' || model.name === model.id ? model.id : `${model.id}  ${model.name}`,
                    subtitle: provider.name === '' ? provider.id : provider.name,
                    provider: provider.id,
                    model: model.id,
                    active: model.id === this.tab.modelName,
                });
            }
        }
        return rows;
    }
    /** Open the model picker. */
    async showModels() {
        this.setStatus('loading models…');
        this.paint();
        try {
            const rows = await this.listModelRows();
            if (rows.length === 0) {
                this.setStatus('no models available — is a provider credential set?', true);
                this.paint();
                return;
            }
            this.picker.show('models', 'Models', rows, { grouped: true });
            // Start on the model already in use, so enter is a no-op rather than a
            // surprise switch.
            const current = rows.find((row) => row.active === true);
            if (current !== undefined)
                this.picker.selectById(current.id);
            this.setStatus('');
        }
        catch (error) {
            this.setStatus(describeError(error), true);
        }
        this.paint();
    }
    /**
     * Resolve `/model <name>` against the catalog. Accepts a bare model id, or
     * `provider/model` when two routes serve the same id.
     */
    async selectModelByName(request) {
        this.setStatus('resolving model…');
        this.paint();
        const rows = await this.listModelRows();
        const wanted = request.toLowerCase();
        const matches = rows.filter((row) => row.id.toLowerCase() === wanted || (row.model ?? '').toLowerCase() === wanted);
        if (matches.length === 0) {
            this.setStatus(`unknown model ${request} — /model lists them`, true);
            this.paint();
            return;
        }
        if (matches.length > 1) {
            this.setStatus(`${request} is served by several routes — use provider/model`, true);
            this.paint();
            return;
        }
        const chosen = matches[0];
        if (chosen !== undefined)
            await this.switchModel(chosen);
    }
    /**
     * Switch the active session's model. The running Agent's selection was
     * installed when it was created, so the switch re-resolves the Agent
     * against the same Session — that keeps the conversation instead of
     * starting a new one — and saves the choice as the default for future
     * sessions. Only this session's ref moves: every other tab keeps routing
     * through its own, unchanged selection.
     */
    async switchModel(row) {
        const defaultModel = this.ctx.get('agentDefaultModel');
        if (defaultModel === undefined)
            return;
        if (row.provider === undefined || row.model === undefined)
            return;
        if (this.tab.streaming) {
            this.setStatus('cannot switch model while a reply is streaming', true);
            this.paint();
            return;
        }
        // Mutating this tab's installed ref is the whole switch: the running
        // Agent reads it when the next step enters prompt assembly, so the
        // conversation and the Session carry on untouched — and no other tab's
        // Agent shares the ref, so they are not rerouted.
        const tab = this.tab;
        const next = {
            ...(tab.selection.current ?? defaultModel.currentSelection()),
            provider: row.provider,
            model: row.model,
        };
        tab.selection.current = next;
        tab.modelName = row.model;
        // A restored tab should answer on the model its conversation was moved to.
        this.persistSoon();
        void this.refreshContextLimit(tab);
        // Token counts belong to the previous route's accounting.
        tab.haveUsage = false;
        this.setStatus(`model → ${row.model}`);
        this.paint();
        // Persisting is only about what a future session starts with, so a store
        // without a settings provider must not surface as a failed switch.
        try {
            await defaultModel.saveSelection(next);
        }
        catch (error) {
            this.setStatus(`model → ${row.model} (not saved: ${describeError(error)})`, true);
            this.paint();
        }
    }
    /**
     * The first-run setup list, shown once on a fresh install.
     *
     * A new user's questions are all of the same shape — which language, which
     * palette, how do I sign in — and before this existed each answer lived
     * behind a different command the newcomer had not read about yet. The list
     * is therefore just doors into the pickers that already answer them, plus
     * the one setup step that is a shell command. It appears only until it is
     * dismissed: `enter` on the last row or `esc` records that this machine has
     * seen it, and it never comes back unasked.
     */
    showSetupWizard() {
        const rows = [
            {
                id: 'lang',
                title: 'Interface language',
                subtitle: LANGS.find((entry) => entry.id === currentLanguage())?.label ?? 'English',
            },
            {
                id: 'theme',
                title: 'Color palette',
                subtitle: activeTheme(),
            },
            { id: 'login', title: 'Sign in to a provider', subtitle: 'Claude, ChatGPT — /providers' },
            { id: 'voice', title: 'Set up voice control', subtitle: 'npm run setup-voice' },
            { id: 'done', title: 'Done', subtitle: 'close this list; it will not return' },
        ];
        this.picker.show('setup', 'Set Moqi up', rows);
        this.setStatus('enter opens a step · esc closes this list for good');
        this.paint();
    }
    /** Record that the setup list has been seen and must not return unasked. */
    finishSetup() {
        if (this.persisted.setupDone === true)
            return;
        this.persisted.setupDone = true;
        this.persistSoon();
    }
    /**
     * Open the palette picker. The rows come straight from the theme table, so
     * a palette added there shows up here with no further wiring.
     */
    showThemes() {
        const current = activeTheme();
        // The base a cancelled preview returns to; see syncPickerPreview.
        this.previewBaseTheme = current;
        const rows = listThemes().map((theme) => ({
            id: theme.name,
            title: theme.name,
            subtitle: theme.description,
            active: theme.name === current,
        }));
        this.picker.show('themes', 'Themes', rows);
        // Start on the palette in use, so esc and enter are both a no-op.
        this.picker.selectById(current);
        this.setStatus('');
        this.paint();
    }
    /**
     * Install a palette by name and redraw.
     *
     * A palette change moves the color of nearly every cell, and the screen
     * driver only rewrites lines whose text it has seen change — so the cache
     * has to be dropped explicitly or the old colors stay on screen until
     * something else happens to touch those rows.
     */
    selectTheme(name) {
        // Committing a palette is the one preview exit that must not restore.
        this.previewBaseTheme = undefined;
        if (!applyTheme(name)) {
            this.setStatus(`unknown theme ${name} — /theme lists them`, true);
            this.paint();
            return;
        }
        // This tab's own choice. The app-wide default a brand new session starts
        // from is still `activeTheme()`, persisted separately below — the two
        // agree here because this is also the active tab.
        this.tab.theme = activeTheme();
        this.persistSoon();
        this.setStatus(`theme → ${activeTheme()}`);
        this.screen.invalidate();
        this.paint();
    }
    // -------------------------------------------------------------- plugins
    /** The directory of the profile this app booted from, or why there is none. */
    profileDir() {
        const name = activeProfileName();
        if (name === undefined) {
            return { error: 'launched without --profile — there is no plugin list to show' };
        }
        const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh');
        return { dir: resolveProfileDir(name, home), name };
    }
    /** `/plugins` with nothing after it: the picker over the profile's packages. */
    showPlugins() {
        const profile = this.profileDir();
        if ('error' in profile) {
            this.setStatus(profile.error, true);
            this.paint();
            return;
        }
        const manifest = readProfileManifest(profile.dir);
        const rows = listPlugins(manifest).map((entry) => ({
            id: entry.name,
            title: entry.name,
            // The dependency spec, or the fact that the layer came in the box.
            subtitle: entry.spec !== '' ? entry.spec : entry.installed ? '' : 'in-box',
            active: entry.enabled,
        }));
        if (rows.length === 0) {
            this.setStatus(`no packages listed in profile ${profile.name}`, true);
            this.paint();
            return;
        }
        this.picker.show('plugins', 'Plugins', rows);
        this.setStatus('enter toggles a package · restart applies it');
        this.paint();
    }
    /** `/plugins <verb> …` — everything the pane cannot do with the enter key. */
    handlePluginsInput(input) {
        if (input === '') {
            this.showPlugins();
            return;
        }
        const [verb, ...rest] = input.split(/\s+/);
        const argument = rest.join(' ').trim();
        if (verb === 'add')
            this.confirmAddPlugin(argument);
        else if (verb === 'remove')
            this.confirmRemovePlugin(argument);
        else
            this.setStatus('usage: /plugins [add <pkg> | remove <pkg>]', true);
        this.paint();
    }
    /** Enable or disable the row the picker landed on. */
    togglePlugin(name) {
        const profile = this.profileDir();
        if ('error' in profile) {
            this.setStatus(profile.error, true);
            return;
        }
        const manifest = readProfileManifest(profile.dir);
        const enabled = !isPluginEnabled(manifest, name);
        const edit = setPluginEnabled(manifest, name, enabled);
        if (!edit.changed) {
            this.setStatus(edit.reason, true);
            return;
        }
        writeProfileManifest(profile.dir, edit.manifest);
        this.setStatus(`${name} ${enabled ? 'enabled' : 'disabled'} — restart to apply`);
    }
    // ------------------------------------------------------- plugin panels
    /**
     * Raise a plugin panel's masked prompt.
     *
     * The host owns the input surface: the draft is drawn as bullets and the
     * value crosses the seam only on submit. `undefined` means the user backed
     * out or answered nothing, and no secret is submitted.
     */
    async askSecret(title, message, placeholder) {
        const login = new LoginPanel(title);
        this.panel = login;
        const answer = new Promise((resolve, reject) => {
            this.secretPrompt = { resolve, reject };
        });
        login.setPrompt({ kind: 'secret', message, placeholder });
        this.setStatus('typing is masked · enter submits · esc cancels');
        this.paint();
        let value;
        try {
            value = await answer;
        }
        catch {
            this.secretPrompt = undefined;
            if (this.panel === login)
                this.panel = undefined;
            return undefined;
        }
        this.secretPrompt = undefined;
        if (this.panel === login)
            this.panel = undefined;
        return value.trim() === '' ? undefined : value;
    }
    /** Answer a waiting {@link askSecret} prompt. `false` when none waits. */
    answerSecret(value) {
        const pending = this.secretPrompt;
        if (pending === undefined)
            return false;
        this.secretPrompt = undefined;
        pending.resolve(value);
        return true;
    }
    /** Cancel a waiting {@link askSecret} prompt. `false` when none waits. */
    cancelSecret() {
        const pending = this.secretPrompt;
        if (pending === undefined)
            return false;
        this.secretPrompt = undefined;
        pending.reject(new AuthorizationDeclinedError());
        return true;
    }
    /** `/plugins add <pkg>` — install into the profile, then compose it. */
    confirmAddPlugin(argument) {
        const parsed = parsePackageRequest(argument);
        if (!parsed.ok) {
            this.setStatus(parsed.reason, true);
            return;
        }
        const request = parsed.request;
        const profile = this.profileDir();
        if ('error' in profile) {
            this.setStatus(profile.error, true);
            return;
        }
        this.confirm(`Install ${request.spec} into ${profile.name}? Its install scripts run as you.`, () => {
            void this.performAddPlugin(profile.dir, request.spec, request.name);
        });
    }
    async performAddPlugin(dir, spec, name) {
        this.setStatus(`installing ${spec}…`);
        this.paint();
        const install = await runPackageManager(dir, ['add', spec]);
        if (!install.ok) {
            this.setStatus(install.message, true);
            this.paint();
            return;
        }
        // The install may have reordered the manifest; re-read before composing.
        const manifest = readProfileManifest(dir);
        const edit = setPluginEnabled(manifest, name, true);
        if (edit.changed)
            writeProfileManifest(dir, edit.manifest);
        this.setStatus(`${install.message} — restart to compose it`);
        this.paint();
    }
    /** `/plugins remove <pkg>` — uncompose it, then uninstall it. */
    confirmRemovePlugin(argument) {
        const name = argument.trim();
        if (name === '') {
            this.setStatus('name the package to remove', true);
            return;
        }
        const profile = this.profileDir();
        if ('error' in profile) {
            this.setStatus(profile.error, true);
            return;
        }
        this.confirm(`Remove ${name} from ${profile.name}?`, () => {
            void this.performRemovePlugin(profile.dir, name);
        });
    }
    async performRemovePlugin(dir, name) {
        // The stack is edited first: a name left in `bundles` with no package
        // behind it stops the profile booting, so that must not survive a failure.
        const manifest = readProfileManifest(dir);
        const edit = forgetPlugin(manifest, name);
        if (edit.changed)
            writeProfileManifest(dir, edit.manifest);
        const removal = await runPackageManager(dir, ['remove', name]);
        this.setStatus(removal.ok ? `${removal.message} — restart to apply` : `${removal.message} (uncomposed anyway)`, !removal.ok);
        this.paint();
    }
    /** Open a picker over the sessions already open in this app. */
    showOpenSessions() {
        const rows = this.tabs.map((tab, index) => ({
            id: String(index),
            title: `${String(index + 1)}. ${tab.title === '' ? 'new session' : tab.title}`,
            subtitle: tab.streaming ? 'running' : tab.status === 'ready' ? 'ready' : 'idle',
            active: index === this.active,
        }));
        // Starting a conversation is the other thing you come to this list to do,
        // so it is an entry here rather than a key you have to already know.
        rows.push({ id: NEW_SESSION_ROW, title: '+  Ask the harness in a new session', subtitle: 'ctrl+n' });
        this.picker.show('open', 'Open sessions', rows);
        this.picker.selectById(String(this.active));
        this.setStatus('');
        this.paint();
    }
    /** Open the session picker, listing what the query service can see. */
    async showSessions(mode = 'resume') {
        const query = this.ctx.get('sessionQuery');
        if (query === undefined) {
            this.setStatus('this profile has no session query service', true);
            this.paint();
            return;
        }
        this.setStatus('loading sessions…');
        this.paint();
        try {
            const rows = await listSessions(query);
            if (rows.length === 0) {
                this.setStatus('no earlier sessions found');
                this.paint();
                return;
            }
            if (mode === 'delete') {
                // A session open in a tab must not be pulled out from under it.
                const open = new Set(this.tabs.map((tab) => tab.id));
                const deletable = rows.filter((row) => !open.has(row.id));
                if (deletable.length === 0) {
                    this.setStatus('every stored session is open here — /close one first', true);
                    this.paint();
                    return;
                }
                this.picker.show('delete', 'Delete a session', deletable);
                this.setStatus('');
            }
            else {
                this.picker.show('sessions', 'Sessions', rows);
                this.setStatus('');
            }
        }
        catch (error) {
            this.setStatus(describeError(error), true);
        }
        this.paint();
    }
    /** Ask, then remove a stored session from disk for good. */
    confirmDelete(id, title) {
        const label = title === '' ? id : title;
        this.confirm(`Delete "${label}" for good?`, () => {
            void this.performDelete(id, label);
        });
    }
    async performDelete(id, label) {
        try {
            const dir = await findStoredSessionDir(id);
            if (dir === undefined) {
                this.setStatus(`no stored session ${label}`, true);
                this.paint();
                return;
            }
            const removed = await deleteStoredSessionDir(dir);
            this.setStatus(removed ? `deleted ${label}` : `no stored session ${label}`, !removed);
        }
        catch (error) {
            this.setStatus(`delete failed: ${describeError(error)}`, true);
        }
        this.paint();
    }
    /** Adopt an existing session and load its transcript. */
    async openSession(id, title) {
        const agents = this.ctx.get('agents');
        const defaultModel = this.ctx.get('agentDefaultModel');
        if (agents === undefined || defaultModel === undefined)
            return;
        this.setStatus('loading…');
        this.paint();
        const selection = this.tab.selection.current ?? defaultModel.currentSelection();
        this.tab.selection.current = selection;
        this.tab.modelName = String(selection.model);
        try {
            const resumed = await agents.resume({
                resumeSessionId: brandString(id),
                agentOptions: { provider: selection.provider, model: selection.model },
                setup: this.selectionSetupFor(this.tab),
            });
            this.tab.agent = resumed.agent;
            this.adoptForeground(this.tab);
            await this.tab.agent.whenIdle();
            // The tab now *is* that session. Leaving the old id behind made presence
            // publish the wrong one to the fleet and let `/delete` offer the session
            // this very tab had open, and a restore would have remembered the id of
            // a conversation nobody was looking at.
            this.tab.id = id;
            this.tab.title = title;
            this.refreshFromSession();
            this.tab.scrollBack = 0;
            // This tab now points at a different session than the one remembered.
            this.persistSoon();
            this.setStatus('');
        }
        catch (error) {
            this.setStatus(describeError(error), true);
        }
        this.paint();
    }
    /** Re-read the transcript from the agent's session log. */
    refreshFromSession() {
        if (this.tab.agent === undefined)
            return;
        try {
            this.tab.messages = readHistory(this.tab.agent.session);
        }
        catch {
            // A log the app cannot parse is not a reason to lose the screen.
        }
    }
    /** Restore the terminal and ask the launcher to exit. */
    quit() {
        this.abort?.abort();
        this.stop();
        this.exit(0);
    }
    /**
     * The two-step ctrl+c: the first press opens the sessions menu (or, when a
     * picker is already up, just arms the confirmation), and a second press
     * inside the window quits. Anything else leaves the app running.
     */
    requestQuit() {
        const now = Date.now();
        if (now - this.lastQuitRequest < QUIT_CONFIRM_MS) {
            this.quit();
            return;
        }
        this.lastQuitRequest = now;
        if (this.picker.kind === 'none')
            this.showOpenSessions();
        this.setStatus('ctrl+c again to quit');
        this.paint();
    }
}
/**
 * Mount the terminal app.
 * @param ctx - plugin context carrying the core services and launcher exit.
 * @param config - validated startup options.
 */
export function apply(ctx, config) {
    const exit = ctx.get('appExit');
    if (exit === undefined) {
        throw new Error('moqi: the launcher must provide ctx.appExit before the tree mounts');
    }
    const app = new TuiApp(ctx, config, exit);
    // Registering the teardown as an effect is what guarantees the terminal is
    // restored when the tree unwinds — a reload or a failure elsewhere in the
    // profile must not leave the user in the alternate screen with no cursor.
    ctx.effect(() => () => {
        app.stop();
    });
    void app.start().catch((error) => {
        app.stop();
        process.stderr.write(`dsh: ${describeError(error)}\n`);
        exit(1);
    });
}
