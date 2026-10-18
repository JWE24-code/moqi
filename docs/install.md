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

From source — clone, build, and link the profile to the checkout:

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
