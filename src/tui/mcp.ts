/**
 * `/mcp` formatting: which MCP servers' tools are actually mounted.
 *
 * The MCP client is a composition-level plugin — servers are declared in the
 * profile, not registered through a queryable runtime API — so the honest view
 * is the tool registry filtered to MCP-provided names. This module does the
 * naming and grouping; the app layer does the probing.
 * @module
 */

/** One MCP server and the tools it contributed. */
export interface McpServer {
  name: string
  tools: string[]
}

/**
 * The separator conventions MCP bridges use in tool names.
 *
 * `mcp__server__tool` is the Claude-style double-underscore form; `server/tool`
 * and `server:tool` appear in some bridges. Parsing all three means a server
 * shows up whichever bridge mounted it.
 */
export function parseMcpToolName(name: string): { server: string; tool: string } | undefined {
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length)
    const at = rest.indexOf('__')
    if (at <= 0 || at === rest.length - 2) return undefined
    return { server: rest.slice(0, at), tool: rest.slice(at + 2) }
  }
  if (name.startsWith('mcp_')) {
    const rest = name.slice('mcp_'.length)
    const at = rest.indexOf('_')
    if (at <= 0 || at === rest.length - 1) return undefined
    return { server: rest.slice(0, at), tool: rest.slice(at + 1) }
  }
  for (const separator of ['/', ':']) {
    const parts = name.split(separator)
    // Exactly two segments, neither a path or a filename: `files/read` is a
    // bridge, `src/tui/state.ts` is a path and must not become a server.
    if (parts.length !== 2) continue
    const [head, tail] = parts as [string, string]
    if (head.includes('.') || tail.includes('.')) continue
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(head)) continue
    if (tail === '') continue
    return { server: head, tool: tail }
  }
  return undefined
}

/** Group tool names into their MCP servers, alphabetically by server then tool. */
export function groupMcpTools(toolNames: readonly string[]): McpServer[] {
  const servers = new Map<string, string[]>()
  for (const name of toolNames) {
    const parsed = parseMcpToolName(name)
    if (parsed === undefined) continue
    const list = servers.get(parsed.server) ?? []
    list.push(parsed.tool)
    servers.set(parsed.server, list)
  }
  return [...servers.entries()]
    .map(([name, tools]) => ({ name, tools: [...tools].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The `/mcp` overlay body.
 *
 * @param servers - grouped MCP tools, from {@link groupMcpTools}.
 * @param totalTools - every tool the registry offers, for the empty case.
 */
export function renderMcp(servers: readonly McpServer[], totalTools: number): string {
  if (servers.length === 0) {
    return [
      '**MCP servers**',
      '',
      totalTools === 0
        ? 'This profile exposes no tool registry to the app.'
        : `No MCP-provided tools are mounted (${String(totalTools)} tools in total).`,
      '',
      'Servers are declared in the profile, not added at runtime:',
      '',
      '- `dsh plugin --profile tui add <mcp-bridge-package>`',
      '- or an `mcp-client` entry in `$DSH_HOME/profiles/tui/cordis.patch.yml`',
    ].join('\n')
  }
  const lines: string[] = ['**MCP servers**', '']
  const toolCount = servers.reduce((sum, server) => sum + server.tools.length, 0)
  lines.push(`${String(servers.length)} server${servers.length === 1 ? '' : 's'}, ${String(toolCount)} tools`, '')
  for (const server of servers) {
    lines.push(`- **${server.name}** (${String(server.tools.length)})`)
    for (const tool of server.tools) lines.push(`  - \`${tool}\``)
  }
  lines.push('', 'Tools are granted by composition; nothing is added at runtime.')
  return lines.join('\n')
}
