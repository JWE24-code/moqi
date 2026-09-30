/**
 * Interface language: one catalog, looked up by key.
 *
 * The scope is deliberate: the chrome a reader reads — the welcome, the key
 * reference, the trust panels, and the footer hints. Operational status lines
 * (what a command just did) stay English because they are diagnostics, not
 * interface, and translating a moving target is how a UI ends up half in each
 * language.
 *
 * A missing key falls back to English and then to the key itself, so a new
 * string can never render as blank.
 * @module
 */

/** The languages the interface ships with. */
export type Lang = 'en' | 'zh-CN'

/** Every language, in menu order, with the label to show in a picker. */
export const LANGS: readonly { id: Lang; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'zh-CN', label: '简体中文' },
]

/** Whether an untrusted string names a language this build speaks. */
export function isLang(value: string): value is Lang {
  return LANGS.some((entry) => entry.id === value)
}

type Catalog = Record<string, string>

const EN: Catalog = {
  'welcome.title': '◆  Moqi',
  'welcome.connected': 'connected to {host}  ·  {model}',
  'welcome.harness': 'sessions, compaction and tools live in the harness',
  'welcome.type': 'type a message, or ',
  'welcome.forCommands': ' for commands',

  'footer.hint': '/ commands  ·  ? help  ·  ctrl+c menu',
  'footer.scrolled': '↑ {lines} line{s}  ·  ctrl+g newest',
  'footer.recording': '{spinner} ● recording  ·  ctrl+v stop  ·  esc cancel',
  'footer.transcribing': '{spinner} transcribing…',

  'approval.title': 'Allow {tool}?',
  'approval.allow': 'Allow once',
  'approval.allowDetail': 'run this one call',
  'approval.deny': 'Deny',
  'approval.denyDetail': 'the agent is told no',
  'approval.hint': '↑↓ move · enter choose · 1 allow · 2 deny · esc denies',

  'questions.title': 'Question',
  'questions.of': 'Question {n} of {total}',
  'questions.answer': 'Answer',
  'questions.answerPlaceholder': '(type an answer)',
  'questions.hint': '↑↓ move · enter choose · tab type an answer · esc back',
  'questions.hintMulti': '↑↓ move · space toggle · enter next · tab type an answer · esc back',
  'questions.hintPlan': '↑↓ move · enter decide · type feedback to keep planning · esc back',
  'questions.cancelSuffix': ' · esc cancels',

  'help.body': [
    '**Keys**',
    '',
    '- `enter` — send · steers into a running reply · `shift+enter` — newline',
    '- `↑` / `↓` on the first / last row — recall earlier prompts',
    '- `/` — command palette · `tab` accept · `esc` dismiss',
    '- `@` — file completion · `tab`/`enter` accept · `esc` dismiss',
    '- `esc` — clear a search, else interrupt a reply while it is streaming',
    '- `tab` while streaming queues · `/unqueue` discards · `/interrupt` runs them',
    '- `ctrl+n` — new session · `ctrl+r` — resume · `ctrl+t` — toggle thinking',
    '- `pgup` / `pgdn` — page · `shift+↑` / `shift+↓` — one line · `ctrl+g` — newest',
    '- `ctrl+↑` / `ctrl+↓` — half page · `ctrl+u` — clear the composer',
    '- `alt+e` — edit draft · `alt+↑`/`alt+↓` select a turn · `alt+c` — copy it',
    '- `ctrl+o` — tool calls · `ctrl+x` — compact · `ctrl+b` — background agents',
    '- `ctrl+y` — copy the last reply · `ctrl+f` — every device · `ctrl+v` — push to talk',
    '- `?` — open this help on an empty composer',
    '',
    '**Sessions**',
    '',
    '- `ctrl+n` — new session · `alt+1`…`alt+9` jump · `tab` on empty cycles · `/sessions` picks',
    '- `/close` · `/rename <t>` · `/rewind` redo · `/fork` twin · `/tree` lineage · `/jobs`',
    '- `ctrl+a` / `ctrl+e` — start / end of line · `ctrl+w` — delete word · `ctrl+d` — delete forward',
    '',
    '**Fleet** (`ctrl+f`, `/fleet`) — every device running this app, by machine',
    '',
    '- `↑`/`↓` move · `r` refresh · `enter` open · `p` preview · `d` dispatch · `esc` back',
    '- a session elsewhere copies the `ssh` that reaches it; `--peer <host>` adds one',
    '',
    '**Plugins** (`/plugins`) — the packages this profile composes',
    '',
    '- `enter` — enable or disable the selected package · restart to apply',
    '- `/plugins add|remove <pkg>` — both confirm; install scripts run as you',
    '- plugin panels (`/JevLoop` is one) join the palette while mounted',
    '',
    '**Searching, palettes and lists**',
    '',
    '- `/find <text>` — search · `n` / `N` on an empty composer — next / previous',
    '- `/find --sessions <text>` — search every stored session on this machine',
    '- `/theme` — pick a palette · `mono` is greyscale · in a list: type to filter',
    '',
    '**Decisions** — when the agent stops to ask, the panel owns the keyboard',
    '',
    '- approval: `1` allow once · `2` / `esc` deny · questions: `↑`/`↓`, `space`, `enter`, `tab`',
    '- plan review: `enter` approves or keeps planning · typing is feedback',
    '',
    '**Commands**',
    '',
    'Type `/` for every command the harness has registered, its own plugins too.',
    '',
    '- `ctrl+c` — sessions menu · again within 1.5s — quit',
  ].join('\n'),
}

const ZH: Catalog = {
  'welcome.title': '◆  Moqi',
  'welcome.connected': '已连接 {host}  ·  {model}',
  'welcome.harness': '会话、压缩与工具都在 harness 中',
  'welcome.type': '输入消息，或用 ',
  'welcome.forCommands': ' 打开命令',

  'footer.hint': '/ 命令  ·  ? 帮助  ·  ctrl+c 菜单',
  'footer.scrolled': '↑ {lines} 行  ·  ctrl+g 回到最新',
  'footer.recording': '{spinner} ● 正在录音  ·  ctrl+v 停止  ·  esc 取消',
  'footer.transcribing': '{spinner} 正在转写…',

  'approval.title': '允许 {tool}？',
  'approval.allow': '允许一次',
  'approval.allowDetail': '只运行这一次调用',
  'approval.deny': '拒绝',
  'approval.denyDetail': '告诉 agent 不行',
  'approval.hint': '↑↓ 移动 · enter 选择 · 1 允许 · 2 拒绝 · esc 拒绝',

  'questions.title': '提问',
  'questions.of': '第 {n} / {total} 个问题',
  'questions.answer': '回答',
  'questions.answerPlaceholder': '（输入回答）',
  'questions.hint': '↑↓ 移动 · enter 选择 · tab 输入回答 · esc 返回',
  'questions.hintMulti': '↑↓ 移动 · space 多选 · enter 下一个 · tab 输入回答 · esc 返回',
  'questions.hintPlan': '↑↓ 移动 · enter 决定 · 直接输入即为反馈 · esc 返回',
  'questions.cancelSuffix': ' · esc 取消',

  'help.body': [
    '**按键**',
    '',
    '- `enter` — 发送 · 回复中则插入运行中的回合 · `shift+enter` — 换行',
    '- 首行 / 末行的 `↑` / `↓` — 调出历史提示词',
    '- `/` — 命令面板 · `tab` 接受 · `esc` 关闭',
    '- `@` — 文件补全 · `tab`/`enter` 接受 · `esc` 关闭',
    '- `esc` — 先清搜索，否则打断正在流式的回复',
    '- 流式中 `tab` 排队 · `/unqueue` 丢弃 · `/interrupt` 立即执行',
    '- `ctrl+n` — 新会话 · `ctrl+r` — 恢复 · `ctrl+t` — 思考显示',
    '- `pgup` / `pgdn` — 翻页 · `shift+↑` / `shift+↓` — 一行 · `ctrl+g` — 最新',
    '- `ctrl+↑` / `ctrl+↓` — 半页 · `ctrl+u` — 清空输入框',
    '- `alt+e` — 外部编辑器 · `alt+↑`/`alt+↓` 选中回合 · `alt+c` — 复制',
    '- `ctrl+o` — 工具调用 · `ctrl+x` — 压缩 · `ctrl+b` — 后台 agent',
    '- `ctrl+y` — 复制上一条回复 · `ctrl+f` — 所有设备 · `ctrl+v` — 语音输入',
    '- 输入框为空时 `?` — 打开本帮助',
    '',
    '**会话**',
    '',
    '- `ctrl+n` — 新会话 · `alt+1`…`alt+9` 跳转 · 空输入框 `tab` 循环 · `/sessions` 选择',
    '- `/close` · `/rename <标题>` · `/rewind` 重来 · `/fork` 分身 · `/tree` 谱系 · `/jobs`',
    '- `ctrl+a` / `ctrl+e` — 行首 / 行尾 · `ctrl+w` — 删词 · `ctrl+d` — 向后删除',
    '',
    '**舰队**（`ctrl+f`、`/fleet`）— 每台运行本应用的机器',
    '',
    '- `↑`/`↓` 移动 · `r` 刷新 · `enter` 打开 · `p` 预览 · `d` 下发任务 · `esc` 返回',
    '- 其他设备上的会话会复制出可达的 `ssh` 命令；`--peer <主机>` 添加设备',
    '',
    '**插件**（`/plugins`）— 该 profile 组合的软件包',
    '',
    '- `enter` — 启用或停用所选包 · 重启后生效',
    '- `/plugins add|remove <包>` — 都会确认；安装脚本以你的身份运行',
    '- 插件面板（如 `/JevLoop`）在挂载时加入命令面板',
    '',
    '**搜索、配色与列表**',
    '',
    '- `/find <文本>` — 搜索 · 空输入框 `n` / `N` — 下一个 / 上一个',
    '- `/find --sessions <文本>` — 搜索本机所有已存储会话',
    '- `/theme` — 选择配色 · `mono` 为灰度 · 列表中输入即筛选',
    '',
    '**需要决定时** — 面板接管键盘',
    '',
    '- 审批：`1` 允许一次 · `2` / `esc` 拒绝 · 提问：`↑`/`↓`、`space`、`enter`、`tab`',
    '- 计划审核：`enter` 批准或继续规划 · 直接输入即为反馈',
    '',
    '**命令**',
    '',
    '输入 `/` 查看 harness 注册的全部命令，包括其插件。',
    '',
    '- `ctrl+c` — 会话菜单 · 1.5 秒内再次按下 — 退出',
  ].join('\n'),
}

const CATALOGS: Record<Lang, Catalog> = { en: EN, 'zh-CN': ZH }

/**
 * Every key one language's catalog defines. Exported for the parity test: a
 * translation that lags a new English string is invisible at runtime (the
 * fallback silently renders English), so the lag has to be caught by a test
 * rather than by a reader.
 */
export function catalogKeys(lang: Lang): readonly string[] {
  return Object.keys(CATALOGS[lang] ?? {})
}

/** Fill `{name}` placeholders; a missing value leaves the placeholder alone. */
export function fill(template: string, params: Record<string, string | number> | undefined): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : whole,
  )
}

/** Look a string up in one explicit language. */
export function translate(lang: Lang, key: string, params?: Record<string, string | number>): string {
  const template = CATALOGS[lang]?.[key] ?? EN[key] ?? key
  return fill(template, params)
}

let active: Lang = 'en'

/** The language the interface is drawing in. */
export function currentLanguage(): Lang {
  return active
}

/** Switch the interface language; the caller persists the choice. */
export function setLanguage(lang: Lang): void {
  active = lang
}

/** Look a string up in the active language. */
export function t(key: string, params?: Record<string, string | number>): string {
  return translate(active, key, params)
}

/** The full key reference in the active language. */
export function helpText(): string {
  return t('help.body')
}
