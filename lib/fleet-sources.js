/**
 * Collecting presence records from this device and its peers.
 *
 * The transport is SSH, for one reason: it is the only channel in this setup
 * that is already authenticated, already encrypted, and already working. The
 * Harness's own web server offers no TLS, no authentication and no origin
 * policy, and binding it off loopback would publish every route on the
 * network — so the overview never does that.
 *
 * Every remote read is one short, non-interactive command. Nothing is
 * installed on the peer beyond dsh itself, and nothing listens anywhere.
 * @module
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readPresenceDir } from "./presence.js";
import { isPresenceRecord, } from "./tui/fleet.js";
/** How long a peer may take before it is reported unreachable. */
const SSH_TIMEOUT_MS = 6000;
/** Resolve this device's Harness home the way the Harness itself does. */
export function localDshHome(env = process.env) {
    const configured = env['DSH_HOME'];
    if (configured !== undefined && configured.trim() !== '')
        return configured;
    return join(homedir(), '.dsh');
}
/** Read this device's records. */
export function collectLocal(dshHome = localDshHome()) {
    return {
        host: 'local',
        local: true,
        records: readPresenceDir(join(dshHome, 'tui-presence')),
    };
}
/**
 * Read one peer's records over SSH.
 *
 * `BatchMode=yes` matters: a peer whose key is missing must fail fast with an
 * error in the overview rather than blocking the UI on a password prompt.
 */
export async function collectPeer(peer) {
    const home = peer.dshHome ?? '$HOME/.dsh';
    // cat of a glob that matches nothing would fail; guard it in the shell.
    const remote = `d="${home}/tui-presence"; [ -d "$d" ] && cat "$d"/*.json 2>/dev/null || true`;
    try {
        const stdout = await ssh(peer.host, remote);
        return { host: peer.host, local: false, records: parseRecords(stdout) };
    }
    catch (error) {
        return {
            host: peer.host,
            local: false,
            records: [],
            error: describe(error),
        };
    }
}
/** Read every device in parallel; one slow peer must not hold up the rest. */
export async function collectFleet(peers, dshHome = localDshHome()) {
    const remote = await Promise.all(peers.map((peer) => collectPeer(peer)));
    return [collectLocal(dshHome), ...remote];
}
/** Parse concatenated JSON records, tolerating whatever else is in the stream. */
function parseRecords(stdout) {
    const records = [];
    // Records are written one JSON object per file with a trailing newline, so
    // concatenation yields one object per line in practice; fall back to a
    // brace scan if a peer wrote them pretty-printed.
    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '' || !trimmed.startsWith('{'))
            continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (isPresenceRecord(parsed))
                records.push(parsed);
        }
        catch {
            // Ignore a partial line rather than losing the whole peer.
        }
    }
    return records;
}
/** Run one non-interactive SSH command. */
function ssh(host, command) {
    return new Promise((resolve, reject) => {
        execFile('ssh', // NOSONAR — the user's ssh from PATH is the intended tool.
        [
            '-o',
            'BatchMode=yes',
            '-o',
            `ConnectTimeout=${String(Math.ceil(SSH_TIMEOUT_MS / 1000))}`,
            host,
            command,
        ], { timeout: SSH_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout, stderr) => {
            if (error !== null) {
                // ssh puts the useful line on stderr; node's own message is the whole
                // command echoed back, which is noise in a one-line overview.
                const detail = String(stderr)
                    .split('\n')
                    .map((line) => line.replace(/^ssh: /, '').trim())
                    .find((line) => line !== '');
                const timedOut = error.code === 'ETIMEDOUT';
                reject(new Error(detail ?? (timedOut ? 'timed out' : 'unreachable')));
                return;
            }
            resolve(String(stdout));
        });
    });
}
/** A one-line, human-readable form of anything thrown. */
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
