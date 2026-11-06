# Releasing Kai for Firefox

Release Firefox runs only signed add-ons, so Kai for Firefox is signed by Mozilla (AMO) as an
unlisted add-on (`scripts/sign.mjs`, `npm run sign`). Where the build runs decides where its
updates come from (design §10): updates from GitLab only for builds from GitLab, GitHub builds'
updates from GitHub, and a build on a desk has no update URL.

| Channel | Made by | Version | `gecko.update_url` of the XPI | The XPI's `update_link` |
| --- | --- | --- | --- | --- |
| builds | GitLab CI, every push to `main` | `<base>.<commit count>` | `<CI_API_V4_URL>/projects/<id>/packages/generic/kai-firefox/updates/updates.json` | `<CI_API_V4_URL>/projects/<id>/packages/generic/kai-firefox/<version>/kai-firefox-<version>.xpi` |
| releases | GitHub Actions, a pushed `vX.Y.Z` tag | `<base>.0` | `https://github.com/lmgw-dev/kai-firefox/releases/latest/download/updates.json` | `https://github.com/lmgw-dev/kai-firefox/releases/download/<tag>/kai-firefox-<version>.xpi` |
| local | `npm run sign` on a desk | `<base>.<commit count>` | none | no `updates.json` is made |

`<base>` is the three-part version in `extension/manifest.json`, which is never changed: the script
splices the version and the update URL into a copy. The channel comes from the environment
(`GITLAB_CI`, `GITHUB_ACTIONS`), not from an option, and `--release` belongs to GitHub Actions: it is
refused anywhere else, and GitHub Actions without it is refused too. A release needs a new `<base>`
(AMO signs each version once).

## Local build

```sh
AMO_JWT_ISSUER=… AMO_JWT_SECRET=… npm run sign              # version <base>.<commit count>, no update URL
npm run sign -- --dry-run                                  # everything except contacting AMO
```

The key pair comes from <https://addons.mozilla.org/developers/addon/api/key/>; a gitignored `.env`
in the repository root works in place of the environment. The XPI is installed by hand and Firefox
does not update it.

`scripts/sign.mjs`:

- refuses a tree with uncommitted changes (the copy and the source upload are made from `HEAD`);
- refuses a sidebar page that `target/sidebar-build.json` does not tie to this commit, or that
  changed since that build (another build, an edit; build it first: `scripts/sidebar.sh`), or, for
  a real run, that was built with another Rust than rustup's at `scripts/ci/rust-version`;
- stages `extension/` under `target/sign/<version>/ext` with the built page in its `sidebar/` and
  runs `web-ext lint` on it;
- builds `source.zip` (the source upload AMO asks for, with a `BUILD-FOR-REVIEWERS.md` at its
  root);
- signs with `web-ext sign --channel=unlisted` and leaves the XPI in
  `target/sign/<version>/signed/`, with its sha256. It prints when AMO's part started and ended and
  how long it took.

It is resumable: when AMO already knows the version, the signed file is downloaded, a pending one
is waited for (`--wait-min`, default 60) and a rejected one fails with AMO's status. AMO signs each
version once, so a failed run is repeated, not bumped. The downloaded file is checked against the
run: its version and its `update_url` must be the ones this channel wants, so a file an earlier
local run signed for the same commit is not taken for a CI build (make a commit and sign again).

With an update channel the script also leaves `kai-firefox-<version>.xpi` (the same file under the
name its `update_link` has) and `updates.json` in `target/sign/<version>/`: one entry, the newest,
with the XPI's `sha256:` hash.

## Builds channel: GitLab CI

`.gitlab-ci.yml` has three stages:

- `sidebar` (every branch): Fedora 44 by digest with rustup's Rust at `scripts/ci/rust-version`;
  the sidebar page's unit tests and its release build, with lmgw cloned at `LMGW_PIN`'s commit
  through the job's token, which lmgw's project must allow in its CI/CD settings (Job token
  permissions).
- `check` (every branch): `npm ci`, `npm run lint`, `npm run test:unit`.
- `build` (`main` only): `npm ci`, `npm run sign`, `npm run publish:gitlab`, both taking the built
  page from the `sidebar` job.

Jobs are picked by a runner tag; the node jobs run in `node:22`. `scripts/publish-gitlab.mjs`
runs only in GitLab CI. It uploads the XPI to its version's package, then the same XPI as
`kai-firefox.xpi` and `updates.json` to the `updates` package of the project's generic package
registry, with the job's own token (`JOB-TOKEN`). If the registry's `updates.json` names a higher
version (two pipelines can finish out of order), neither of those two is uploaded.
`target/sign/<version>/` is kept as the job's artifact, without the staged copy in `ext/`.

Set once in the GitLab project:

1. Settings > CI/CD > Variables, both masked and protected (and `main` must be a protected branch,
   as it is by default, or the build job does not get them): `AMO_JWT_ISSUER` and
   `AMO_JWT_SECRET`.
2. Firefox fetches `updates.json` and the XPI without logging in, and the project requires authentication, so one
   of these:
   - **Allow anyone to pull** (the cleaner one): Settings > General > Visibility, project features,
     permissions > Package registry > "Allow anyone to pull from Package Registry". Nothing secret
     is in the XPI then. (Whether GitLab offers the toggle for a project that requires authentication has not been
     checked yet; if it does not, use the deploy token.)
   - **A deploy token**: Settings > Repository > Deploy tokens, scope `read_package_registry`, then a
     third CI/CD variable `KAI_FIREFOX_UPDATE_TOKEN` with the value `<token user>:<token>`. The
     script puts it into `gecko.update_url` and every `update_link` as userinfo
     (`https://user:token@host/...`). That means the token is inside every signed XPI of this
     channel, and Mozilla receives it with the upload. It is read-only on this project's registry,
     and a new token needs a new build to reach the installed copies.
3. Generic packages must allow duplicates: the group's Settings > Packages and registries >
   "Duplicate packages" > Generic > "Allow duplicates" (GitLab's default). `updates.json` and
   `kai-firefox.xpi` are uploaded under the same name for every build, and a package file of the same
   name is a new file that the registry serves in place of the old one. Without it the upload fails
   with a 403 that says so.
4. Install the first build by hand: the CI-built XPI (from the job's artifacts, or the registry),
   through about:addons > gear > Install Add-on From File. Its `update_url` carries all further
   updates; an XPI signed on a desk has none and never updates.

Not yet: CI runs the unit tests (`npm run test:unit`) only. The end-to-end tests (`npm test`) need
headless Firefox and Kai's `kai-browser-host`, which CI does not build yet.

## Releases channel: GitHub

GitHub holds no development history. It receives one squashed commit per publish, an audited and
scanned copy of a tree (`scripts/publish-github.sh`), and the release tag on that commit. The tag
push starts `.github/workflows/release.yml`. The first publish creates the public root commit of
`lmgw-dev/kai-firefox`; the repository has to exist and be empty before it. Nothing has been
published yet and the workflow has not run.

### Set once on GitHub

Create the empty repository `lmgw-dev/kai-firefox` (no README, no licence, no `.gitignore`), then in
Settings > Environments > New environment `amo-release` (the `sign` job names it). Under
"Deployment branches and tags" choose "Selected branches and tags" and add a tag rule `v*` (and no
branch rule), so only a pushed `v*` tag can reach the environment. Under "Environment secrets" add
`AMO_JWT_ISSUER` and `AMO_JWT_SECRET` (from <https://addons.mozilla.org/developers/addon/api/key/>).
Do not put them in the repository secrets: those reach every workflow and branch. No variables are
needed yet. The release job only runs in `lmgw-dev/kai-firefox`, so a fork never meets the secrets.
Not yet: branch protection or a required `CI` check for `main`; that is the owner's to set.

### Set once in each clone

```sh
scripts/publish-github.sh --install-guard
```

It adds the `github` remote (`git@github.com:lmgw-dev/kai-firefox.git`), sets its push URL to
`DISABLED-publish-with-scripts/publish-github.sh` (so a plain `git push github` fails), turns off
tag auto-follow and installs `scripts/pre-push-github.sh` as `pre-push`. The hook refuses any push
to a github.com URL that does not come from the publish script (`KAI_FIREFOX_PUBLISH=1`, a
variable of this repository alone) and the private history, anything descending from this
repository's root commit (`git rev-list --max-parents=0 main`), to every URL but the origin
of the private history. The private denylist (one case-insensitive regular expression per line) lives outside
the repository: `${XDG_CONFIG_HOME:-~/.config}/lmgw/publish-denylist`, or
`KAI_FIREFOX_PUBLISH_DENYLIST`.

### A release

1. lmgw first: `LMGW_PIN`'s `lmgw_tag` must be a published lmgw release with the pinned tree
   (`scripts/lmgw-pin.sh verify-published`). GitHub's workflows clone it. With `unpublished`,
   `release.sh` and `publish-github.sh` refuse.
2. A new `<base>`: change `version` in `extension/manifest.json` and `package.json` in a normal
   commit on `main` (AMO signs each version once; no script bumps it).
3. `scripts/release.sh <notes-file>` tags `v<base>` on a clean `main`; the tag's message (the file,
   Markdown) becomes the release notes. It pushes nothing.
4. Dry run: `scripts/publish-github.sh --dry-run --ref vX.Y.Z -F <message> --tag vX.Y.Z`. It reads
   the public parent from the push URL, writes `target/publish/<tree12>.diff`, `.binaries` and
   `.scan` (secret shapes, every non-GitHub remote host, the denylist), and says what the gate
   would refuse. The commit and tag messages are scanned too.
5. Audit the diff and the scan. Then `scripts/publish-github.sh --approve <tree> --note "who
   audited"`, with `--ack-scan` once every hit is fine.
6. Publish on a terminal: the same command without `--dry-run`, then type `publish`. The commit
   (`git commit-tree <tree> -p <public tip>`, a tree copy, never a merge) and the tag go out in one
   atomic push. The author and committer must be GitHub no-reply addresses.
7. The tag push starts the workflow, in three jobs:
   - `build` (read-only, no secrets) compiles the sidebar page against the public lmgw at
     `lmgw_tag` and runs `sign --release --dry-run`; it hands on the page and its build record.
   - `sign` (read-only, the AMO secrets from the `amo-release` environment) checks the tag out
     again, runs `npm ci --ignore-scripts`, unpacks the build job's artifact outside the checkout,
     checks that it holds only `extension/sidebar/**` and `target/sidebar-build.json` as regular
     files and copies just those in, then runs `npm run sign -- --release`. What runs with the secrets is `scripts/sign.mjs` and the
     modules it imports, `web-ext` and its pinned npm dependencies, and `git`. The page is signed
     as built: `sign.mjs` refuses one that differs from its build record, which is a consistency
     check and no proof against a compromised build job.
   - `publish` (`contents: write`, no checkout) checks the three files and creates the GitHub
     release from the tag's message with `kai-firefox-<base>.0.xpi`, `kai-firefox.xpi` and
     `updates.json`. The release is marked latest, which is what the XPI's `update_url`
     (`releases/latest/download/updates.json`) follows. A published release's files are not
     replaced; a draft left by a failed run is.

`.github/workflows/ci.yml` checks pushes and pull requests on GitHub (the publish scripts' tests,
the sidebar page's tests and build, lint and the unit tests; read-only, no secrets) and needs the
same published `lmgw_tag`. Not yet: the end-to-end tests run there.

## Stable install links

The versioned XPI name changes with every build, so a link to "the newest signed XPI" (Kai's
"Install Kai for Firefox" button in its settings window) uses the fixed name `kai-firefox.xpi`, which
both channels also upload:

| Channel | Install URL |
| --- | --- |
| builds | `<CI_API_V4_URL>/projects/<id>/packages/generic/kai-firefox/updates/kai-firefox.xpi` |
| releases | `https://github.com/lmgw-dev/kai-firefox/releases/latest/download/kai-firefox.xpi` |

Kai's CI variable `KAI_FIREFOX_INSTALL_URL` points at the one of the channel that Kai build is for;
Kai compiles it in. While the GitLab package registry requires authentication, the builds URL needs the deploy
token (the one of `KAI_FIREFOX_UPDATE_TOKEN`, scope `read_package_registry`) as userinfo:
`https://<token user>:<token>@<host>/api/v4/projects/<id>/packages/generic/kai-firefox/updates/kai-firefox.xpi`.
With "Allow anyone to pull from Package Registry" on, it needs no credential. The GitLab copy is
only replaced together with `updates.json`, so an older pipeline that finishes late leaves it on the
newer build.

## The source upload and lmgw

The source upload carries the sidebar's sources, a `rust-toolchain.toml` naming rustup's Rust the
page is built with (`scripts/ci/rust-version`, which both pipelines install) and `build-for-amo.sh`,
which clones the public lmgw at `LMGW_PIN`'s `lmgw_tag`. lmgw's crates themselves are not uploaded.
While `lmgw_tag` is `unpublished` (the pinned lmgw is only in its development repository), a
reviewer cannot rebuild the sidebar page; `npm run sign` says so.
