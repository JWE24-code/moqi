/**
 * Print a rendered frame to stdout, for eyeballing the layout without a
 * profile or a model. Pass `palette`, `picker`, `stream`, or `think` to see
 * those states.
 *
 * Run with: node --experimental-strip-types tests/preview.ts [state]
 */

import { Composer, Palette, Picker, textMessage } from '../src/tui/state.ts'
import { render, type Snapshot } from '../src/tui/view.ts'

const state = process.argv[2] ?? 'normal'

const composer = new Composer()
const palette = new Palette()
const picker = new Picker()

const commands = [
  { name: 'compact', args: '', description: 'Condense history on demand' },
  { name: 'clear', args: '', description: 'Clear the transcript' },
  { name: 'exit', args: '', description: 'Quit dsh' },
  { name: 'help', args: '', description: 'Show keys and commands' },
  { name: 'model', args: '[name]', description: 'Show or switch the active model' },
  { name: 'new', args: '', description: 'Start a new session' },
  { name: 'resume', args: '', description: 'Pick up an earlier session' },
  { name: 'thinking', args: '', description: "Toggle the reasoner's chain-of-thought" },
  { name: 'tools', args: '', description: 'List the tools this agent can call' },
]

if (state === 'palette') {
  composer.setValue('/')
  palette.update('/', commands)
}
if (state === 'picker') {
  picker.show('sessions', 'Sessions', [
    { id: 'session-a', title: 'tail docker logs on docker-host', subtitle: '20m ago' },
    { id: 'session-b', title: 'why is the caddy reload failing', subtitle: '3h ago' },
    { id: 'session-c', title: 'draft the vlan migration plan', subtitle: '2d ago' },
  ])
}
if (state === 'models' || state === 'models-filtered') {
  picker.show(
    'models',
    'Models',
    [
      { id: 'deepseek-official/deepseek-chat', title: 'deepseek-chat', subtitle: 'DeepSeek', provider: 'deepseek-official', model: 'deepseek-chat', active: true },
      { id: 'deepseek-official/deepseek-reasoner', title: 'deepseek-reasoner', subtitle: 'DeepSeek', provider: 'deepseek-official', model: 'deepseek-reasoner' },
      { id: 'zai/glm-4.7', title: 'glm-4.7  GLM-4.7', subtitle: 'z.ai (GLM coding plan)', provider: 'zai', model: 'glm-4.7' },
      { id: 'zai/glm-5-turbo', title: 'glm-5-turbo  GLM-5-Turbo', subtitle: 'z.ai (GLM coding plan)', provider: 'zai', model: 'glm-5-turbo' },
      { id: 'zai/glm-5.2', title: 'glm-5.2  GLM-5.2', subtitle: 'z.ai (GLM coding plan)', provider: 'zai', model: 'glm-5.2' },
      { id: 'zai/glm-5.3', title: 'glm-5.3  GLM-5.3', subtitle: 'z.ai (GLM coding plan)', provider: 'zai', model: 'glm-5.3' },
      { id: 'zai/glm-5.3-flash', title: 'glm-5.3-flash  GLM-5.3-Flash', subtitle: 'z.ai (GLM coding plan)', provider: 'zai', model: 'glm-5.3-flash' },
    ],
    { grouped: true },
  )
  if (state === 'models-filtered') picker.setQuery('g53')
}

const snapshot: Snapshot = {
  columns: process.stdout.columns ?? 92,
  rows: process.stdout.rows ?? 26,
  title: state === 'normal' ? 'tail docker logs' : 'new conversation',
  host: 'local harness',
  modelName: 'deepseek-chat',
  messages: [
    textMessage('user', 'how do i tail the last 50 lines of a container log?'),
    {
      role: 'assistant',
      reasoning: 'The user wants a bounded tail, so --tail plus -f is the right pair.',
      segments: [
        { kind: 'text', text: 'Let me see what is running.' },
        { kind: 'tool', tool: { name: 'shell', status: 'ok', detail: 'docker ps' } },
        {
          kind: 'text',
          text: [
            'Use `docker logs` with `--tail` and `-f`:',
            '',
            '```sh',
            'docker logs --tail 50 -f webui',
            '```',
            '',
            '- `--since 10m` — only the last ten minutes',
            '- `-t` — prefix each line with a timestamp',
          ].join('\n'),
        },
      ],
    },
  ],
  streamingReasoning: '',
  streamingSegments:
    state === 'stream'
      ? [
          { kind: 'text', text: 'Checking the container list' },
          { kind: 'tool', tool: { name: 'shell', status: 'running' as const } },
        ]
      : [],
  streaming: state === 'stream',
  spinner: '⠹',
  status: '',
  statusIsError: false,
  overlay: '',
  showThinking: state === 'think',
  composer,
  palette,
  picker,
  scrollBack: 0,
  expandTools: false,
  sessions: [],
  background: [],
  expandBackground: false,
  elapsedSeconds: 12,
  promptTokens: 1200,
  completionTokens: 312,
  totalTokens: 1512,
  haveUsage: true,
  contextLimit: 65536,
  confirming: false,
}

const frame = render(snapshot)
// eslint-disable-next-line no-console
console.log(frame.lines.join('\n'))
