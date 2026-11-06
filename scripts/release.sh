#!/usr/bin/env bash
# Cut a release: make the annotated tag v<X.Y.Z> on main, where X.Y.Z is the <base> version in
# extension/manifest.json. Pushes nothing and changes no file.
#
# Usage: scripts/release.sh <notes-file>
#
# The manifest's three-part version is the base and is never changed by a script (scripts/sign.mjs
# splices the build's fourth part into a copy: a release is signed as <base>.0). A new release
# therefore needs a new base: change `version` in extension/manifest.json (and package.json) in a
# normal commit first; AMO signs each version once. The tag's message becomes the GitHub release
# notes, Markdown with wrapped lines joined (.github/workflows/release.yml): the notes file, passed
# to git with -F. Then publish:
#   scripts/publish-github.sh --dry-run --ref vX.Y.Z -F <message> --tag vX.Y.Z
#                                  GitHub: one squashed commit with the tag's tree, and the tag on
#                                  it (.github/workflows/release.yml signs and releases it)
#   (audit, --approve, then the same without --dry-run; see that script's header and
#   docs/releasing.md, "Releases channel: GitHub")
# It refuses unless the checkout is a clean `main` and LMGW_PIN's lmgw_tag is a published lmgw
# release with the pinned tree (scripts/lmgw-pin.sh verify-published): GitHub's build clones it.
# Between lmgw releases the pin says `unpublished`, which GitLab's builds take, a release never.
set -euo pipefail
cd "$(dirname "$0")/.."

notes="${1:?usage: scripts/release.sh <notes-file>}"
die() { echo "$*" >&2; exit 1; }

[[ -f "$notes" && -s "$notes" ]] || die "no notes file $notes (or it is empty): the tag's message is the release notes"
[[ "$(git branch --show-current)" == main ]] || die "releases are cut from main"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "commit or stash your changes first"

base="$(sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([0-9]+\.[0-9]+\.[0-9]+)".*$/\1/p' extension/manifest.json | head -n1)"
[[ -n "$base" ]] || die "extension/manifest.json has no three-part version"
num='(0|[1-9][0-9]*)'
[[ "$base" =~ ^$num\.$num\.$num$ ]] || die "not an X.Y.Z version (no leading zeros): $base"
pkg="$(sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]*)".*$/\1/p' package.json | head -n1)"
[[ "$pkg" == "$base" ]] || die "package.json says $pkg, extension/manifest.json says $base: make them agree first"
tag="v$base"
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    die "tag $tag already exists: a new release needs a new version in extension/manifest.json (AMO signs each version once)"
fi
scripts/lmgw-pin.sh verify-published \
    || die "a release needs lmgw's published release in LMGW_PIN first (docs/releasing.md, \"Releases channel: GitHub\")"

git tag -a "$tag" -F "$notes"

echo "tagged $tag at $(git rev-parse --short HEAD). Publish with:"
echo "  scripts/publish-github.sh --dry-run --ref $tag -F <message> --tag $tag"
echo "  (audit, --approve, then the same without --dry-run; see the script's header)"
