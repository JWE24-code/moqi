# Releasing

Moqi is published to npm as [`moqi-tui`](https://www.npmjs.com/package/moqi-tui).
Publishing is automated by `.github/workflows/publish.yml`, which runs when a
GitHub Release is published.

## Why a Release, not a push to main

npm rejects a version that already exists. A publish-on-every-push workflow
therefore has to bump the version itself, which turns an ordinary merge into a
release nobody decided on — and a bad merge into a version that cannot be
taken back. Cutting a GitHub Release is that decision, made deliberately, and
it is the only action that puts a tarball on the registry.

(If automatic per-merge versioning is what you want later, that is a different
tool — changesets or semantic-release — and it should be a deliberate choice
with its own commit convention, not a side effect of the publish workflow.)

## One-time setup: trusted publishing (no token)

The workflow authenticates with npm **trusted publishing**: GitHub's OIDC
identity is exchanged for a short-lived publish credential, so there is no
long-lived `NPM_TOKEN` in the repository to leak or rotate. It also signs the
provenance attestation the same way.

Configure it once, on npmjs.com (this is the part that cannot be done from the
repository):

1. Sign in as the package owner, open
   `https://www.npmjs.com/package/moqi-tui/settings` (Access → Trusted
   Publisher).
2. Add a **GitHub Actions** trusted publisher with:
   - Organization or user: `JWE24-code`
   - Repository: `moqi`
   - Workflow filename: `publish.yml`
   - Environment: leave empty
3. Save. From then on, a Release published from this repository may publish
   the package; nothing else can.

Trusted publishing requires npm ≥ 11.5.1 on the runner, which the workflow
installs before publishing. The package must already exist on the registry for
the publisher to be configured — `moqi-tui` does.

### Alternative: a token

If you would rather not use trusted publishing, create an npm **Automation**
token (it bypasses 2FA, which is the point — Classic "Publish" tokens need an
OTP) and add it as the repository secret `NPM_TOKEN`, then give the publish
step `env: NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`. The token variant gives
up provenance signing, which is why it is the fallback rather than the default.

## The release itself

1. `CHANGELOG.md`: move the `[Unreleased]` entries under the new version.
2. `package.json`: set the same version.
3. `npm run build` and commit `lib/` — it is a committed artifact, and the
   dshfind index checks the manifest's `main` against the tree.
4. Commit, push to `main`, wait for CI to go green.
5. Publish a GitHub Release with a tag matching the version (`v0.3.0` for
   `0.3.0`). The workflow checks the two agree and refuses otherwise.
6. The workflow runs the full gate — `prepublishOnly` re-runs build, typecheck,
   `npm test`, and the packed-artifact check — then publishes with provenance.

There is no marketplace listing step. [dshfind](https://dshfind.com) indexes
public repositories that carry the `dsh-plugin` topic and re-syncs daily, so
the topic is added once per repository rather than per release; its index also
expects the packaged entry (`lib/`) to be committed, which the step above
already guarantees.

A re-run for a version already on the registry reports success and publishes
nothing, so re-running a failed release job is safe. A manual run of the
workflow (Actions → Publish to npm → Run workflow) defaults to a dry run: it
runs the gate and lists the tarball contents without touching the registry.

The local equivalent still works and is worth doing before tagging:

```sh
npm test              # 34 suites, including the pty round trip
npm run test:live     # a real model turn through the TUI (needs credentials)
npm run test:package  # packs, installs into a clean prefix + DSH_HOME, boots
npm run build         # and commit lib/ — see below
npm publish           # prepublishOnly re-runs build + typecheck + npm test
```
## Release gates

Publishing is automated: run the gates below locally, then publish a GitHub
Release whose tag matches `package.json` (`v0.3.0` for `0.3.0`) and the
[Publish to npm](.github/workflows/publish.yml) workflow runs them again on a
clean machine before publishing with provenance. It is triggered by the
Release rather than by a push, because npm rejects an existing version and a
workflow that bumped one for you would turn an ordinary merge into a release
nobody decided on. The one-time npm-side setup — trusted publishing, so no
long-lived token is stored — and the dry-run path are in
[`docs/releasing.md`](docs/releasing.md).

```sh
npm test              # 34 suites, including the pty round trip
npm run test:live     # a real model turn through the TUI (needs credentials)
npm run test:package  # packs, installs into a clean prefix + DSH_HOME, boots
npm run build         # and commit lib/ — see below
npm publish           # prepublishOnly re-runs build + typecheck + npm test
```

**`lib/` is committed, and has to be rebuilt and committed with any source
change.** The dshfind registry inspects this repository's public source tree
and requires the manifest's `main` to be a file that is actually in it; build
output that only appears after `npm run build` fails its check with
`missing_file`. The cost of that is a build artifact in git, and the risk is a
stale one — if `lib/` lags `src/`, the registry describes different code than
npm ships. `tsc` output is deterministic for a given source and compiler, so
`npm run build && git diff --exit-code lib` says whether the tree is honest.

`prepublishOnly` runs all four gates, so publishing needs `dsh` on `PATH` — a
broken artifact must fail the publish rather than reach the registry.

`test:package` exists because the suites all run from the source checkout,
where `link-types` has already made the Harness resolvable — which is exactly
how a tarball that could not resolve `@deepseek-ai/*` once passed every test
and still crashed on boot. It now fails the release instead.
