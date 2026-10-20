# Installing and wiring the profile

Details behind the two commands in the README: what the installer actually
writes, and how typechecking finds the Harness's own types.

`moqi install` only refreshes the profile, and
`dsh plugin --profile tui add moqi-tui` works too. `/update`
inside the app checks npm and upgrades the global install.

The installer also links the installed Harness's own `@deepseek-ai` packages
into the app. This is not optional bookkeeping: the profile links the app from
wherever it was installed, so Node resolves the app's imports from the app's
own directory, where those packages do not otherwise exist — and the app would
crash on boot with `ERR_MODULE_NOT_FOUND`. Linking the harness's copies (rather
than installing a second set) also guarantees exactly one `@deepseek-ai/cordis`,
because two copies would be two different `Service` classes.

## Requirements

- **Node 22+** and the **dsh CLI** (`@deepseek-ai/dsh`).
- **pnpm.** The profile depends on the app through `link:<path>`, which is a
  pnpm protocol that npm rejects (`EUNSUPPORTEDPROTOCOL`). Older versions said
  they would fall back to npm, but that fallback never worked. The installer
  now stops with `no pnpm on PATH` instead. dsh's own `dsh plugin add` uses
  pnpm too. Install pnpm with either of:

  ```sh
  npm install -g pnpm
  corepack enable pnpm     # Node 22 and 24 only; Node 25+ no longer ships corepack
  ```

  Recent pnpm releases are native binaries that come with an install script.
  If `pnpm --version` fails after npm skipped that script, use the
  plain-JavaScript line instead: `npm install -g pnpm@10`.

## Windows

The CLI works on Windows, with the same commands as everywhere else:

```sh
npm install -g @deepseek-ai/dsh pnpm moqi-tui
moqi
```

The installer links the Harness packages as directory junctions, so you don't
need Developer Mode or an administrator shell.

## The dsh desktop app (0.2.1)

The desktop app is an Electron build with dsh packed inside the app bundle. It
puts no `dsh` command on `PATH`, and it has no terminal. Moqi is a terminal app
that runs on the dsh CLI, so install that next to the desktop app:

```sh
npm install -g @deepseek-ai/dsh pnpm moqi-tui
```

You can install the plugins (`dsh-jev-loop`, `dsh-pii-anonymizer`,
`moqi-jev-loop`) into the desktop app's profile, which is called `desktop`:

```sh
dsh plugin --profile desktop add dsh-pii-anonymizer
```

**If the desktop app won't start after you install a plugin**, look in the
profile for `node_modules/@deepseek-ai/*`. A plugin that lists a
`@deepseek-ai/*` package under `dependencies` installs an old copy of a core
package. That copy shadows the one inside the app, and startup fails with
`required plugin did not activate … tools` (upstream
[deepseek-harness#10364](https://github.com/deepseek-ai/deepseek-harness/discussions/10364)).
Delete those copies, remove or update the plugin that pulled them in, and start
the app again. Our three plugins don't do this, and a CI check keeps it that
way.

## Upgrading a profile made before dsh 0.2.1

Older profiles may lack `autoInstallPeers: false` in `pnpm-workspace.yaml`.
Without it, pnpm installs every plugin's `@deepseek-ai/*` peers into the
profile as stale copies. `moqi install` writes `pnpm-workspace.yaml` only when
the file is missing, so it doesn't fix an existing one. Fix it by hand (the
`tui` profile here; use the same steps for any other profile):

```sh
cd ~/.dsh/profiles/tui                 # $DSH_HOME/profiles/tui
grep -q '^autoInstallPeers:' pnpm-workspace.yaml \
  || echo 'autoInstallPeers: false' >> pnpm-workspace.yaml
rm -rf node_modules/@deepseek-ai pnpm-lock.yaml
moqi install
```

You must delete the lockfile as well. Otherwise pnpm restores the copies it
recorded there. Afterwards, `node_modules/@deepseek-ai` should not exist.

## Node version managers (mise, nvm, …)

The installer links about 300 Harness packages into the app by absolute path,
and those paths point into the dsh install of the current Node version. A
version manager keeps a separate set of global packages for each Node version.
After a switch, the links point into the old version's install, or at nothing
once that version is removed. After every Node switch, install dsh, pnpm and
moqi under the new version if they are missing, then run `moqi install` again.

## "install scripts skipped" warnings from npm 11

`npm install -g @deepseek-ai/dsh` on npm 11 warns that it skipped install
scripts for `dsh-subprocess-local`, `koffi`, `node-pty` and a few more. On
Linux and macOS this does no harm: the native prebuilds ship ready to use, and
the only skipped step that matters (node-pty's postinstall) sets the execute
bit on its macOS `spawn-helper`, which the published tarball already has. You
don't need to do anything.

## From source

Clone, build, and link the profile to the checkout:

```sh
git clone https://github.com/JWE24-code/moqi ~/Projects/moqi
cd ~/Projects/moqi
npm install
npm run build              # emits lib/
npm run install-profile    # creates $DSH_HOME/profiles/tui and links this checkout
dsh --profile tui
```

`install-profile` writes the profile directory itself rather than copying a
template, because the profile's dependency on this package has to be an
absolute path to wherever the repository actually lives. It creates:

```
$DSH_HOME/profiles/tui/         # $DSH_HOME defaults to ~/.dsh
  package.json                  # dsh.profile.bundles + a link: to this checkout
  cordis.patch.yml              # your own patch layer, composed last
  pnpm-workspace.yaml           # nodeLinker: hoisted, autoInstallPeers: false
```

with the bundle order the profile composes:

```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "moqi-tui"] } }
```

Pass a name to install under a different profile: `npm run install-profile -- chat`.

**A global install shadows the checkout's bundle patch.** dsh resolves a
profile's bundles from its own installation first, so with `moqi-tui` also
installed globally (`npm install -g moqi-tui`), a checkout profile runs the
checkout's code but the *global* package's `cordis.patch.yml`. A config key
added in the checkout then never arrives. Either remove the global install
while developing, or copy the checkout's complete `tui-app` entry into the
profile's own `$DSH_HOME/profiles/<name>/cordis.patch.yml` — complete, because
a patch replaces an entry's whole `config`, and a partial block silently drops
every other key. `dsh --profile <name> --dump-config` shows what composed.

**Profiles share one state file.** Open sessions and preferences live in
`$DSH_HOME/tui-state.json` for every profile, and quitting writes it. An older
moqi rewrites it without the fields it does not know, so running an old and a
new build side by side loses the newer one's preferences.

### Typechecking against your installed Harness

The `@deepseek-ai/*` imports are optional peers: the Harness resolves them from
its own installation anchor at runtime, so they are deliberately not
dependencies here. To typecheck against the exact build you will run under:

```sh
npm run link-types    # symlinks the installed dsh's @deepseek-ai packages
npm run typecheck
```
