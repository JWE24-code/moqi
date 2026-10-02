/**
 * A live check of the SSH collector, run by hand against real devices.
 *
 * Not part of the automated suite: it needs peers that answer. It proves the
 * two cases that matter operationally — a reachable device with no records,
 * and an unreachable one — degrade the way the overview expects.
 *
 * Run with: node --experimental-strip-types tests/fleet-live.ts [host...]
 */

import { collectLocal, collectPeer } from '../src/fleet-sources.ts'
import { fleetSummary, mergeFleet, renderFleet } from '../src/tui/fleet.ts'

const hosts = process.argv.slice(2)
const peers = hosts.length > 0 ? hosts : ['workstation', 'no-such-host-xyz']

const sources = [collectLocal()]
// Sequential on purpose — the log reads host by host.
await peers.reduce(async (walked, host) => {
  await walked
  const source = await collectPeer({ host })
  // eslint-disable-next-line no-console
  console.log(
    `${host} -> records=${String(source.records.length)} error=${source.error ?? 'none'}`,
  )
  sources.push(source)
}, Promise.resolve())

const rows = mergeFleet(sources, Date.now())
// eslint-disable-next-line no-console
console.log(`\nmerged rows: ${String(rows.length)}  |  ${fleetSummary(rows)}\n`)
// eslint-disable-next-line no-console
console.log(
  renderFleet(rows, { width: 64, sources })
    .join('\n')
    // Strip styling so the output is readable in a log.
    .replace(/\[[0-9;]*m/g, ''),
)
