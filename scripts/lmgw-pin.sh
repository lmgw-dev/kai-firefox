#!/usr/bin/env bash
# The lmgw source the sidebar page is built against (LMGW_PIN; design §8.2, §10), mirroring Kai's
# scripts/lmgw-pin.sh.
# Usage: scripts/lmgw-pin.sh [--at REF] <command>     LMGW_PIN as committed at REF, else as in the
#                                                     working tree
#   stage [lmgw checkout]   copy the pinned tree's crates (git archive, the checkout is only read) to
#                           target/lmgw-pin/, where sidebar/Cargo.toml and sidebar/sidebar.html find
#                           them; again only when the pin changed. The checkout must hold the pinned
#                           tree's objects (any branch): the sibling ../lmgw locally, the CI's clone
#   check [lmgw checkout]   warn, never fail, when the checkout lacks the pinned tree, or when the
#                           pinned commit's tree is not the pinned tree
#   verify-staged [lmgw checkout]
#                           fail unless target/lmgw-pin/ holds exactly the pinned tree's files:
#                           each one's git hash against `git ls-tree` of the tree, none missing,
#                           none added, and the workspace root as `stage` writes it (scripts/sidebar.sh
#                           release runs it before and after its build, since `stage` skips a staged
#                           tree it finds and an edit there would go into a release)
#   verify-tree <checkout>  fail unless the checkout's HEAD has the pinned tree (the GitHub release
#                           workflow, on its clone of the public lmgw at lmgw_tag)
#   verify-published        fail unless lmgw_tag is a release of the public lmgw (LMGW_PUBLIC_URL,
#                           default https://github.com/lmgw-dev/lmgw) with the pinned tree; fetches
#                           the tag alone into target/lmgw-public.git (scripts/release.sh and
#                           scripts/publish-github.sh, before Kai for Firefox goes to GitHub)
#   clone-published <dest>  GitHub's CI: clone the public lmgw at lmgw_tag into <dest> and run
#                           verify-tree on it; fails with a clear message while lmgw_tag is
#                           `unpublished`
#   commit | tag | tree     print the pinned commit, tag or tree; `tag` fails while it is
#                           `unpublished`, as there is no release to clone then
# The checkout: the argument, else $LMGW_DIR, else `lmgw` next to this repository's main checkout
# (a worktree's main checkout is its common git dir's parent).
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
at=""
if [[ "${1:-}" == --at ]]; then
  at="${2:?--at needs a commit}"
  shift 2
  text=$(git -C "$root" show "$at:LMGW_PIN" 2>/dev/null) || { echo "$at has no LMGW_PIN" >&2; exit 1; }
else
  text=$(<"$root/LMGW_PIN")
fi
field() { awk -v k="$1" '$1 == k {print $2}' <<<"$text"; }
pin=$(field lmgw_commit)
tag=$(field lmgw_tag)
tree=$(field lmgw_tree)
[[ "$pin" =~ ^[0-9a-f]{40}$ ]] || { echo "LMGW_PIN holds no 40-hex lmgw_commit" >&2; exit 1; }
[[ "$tree" =~ ^[0-9a-f]{40}$ ]] || { echo "LMGW_PIN holds no 40-hex lmgw_tree" >&2; exit 1; }
[[ "$tag" == unpublished || "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || { echo "LMGW_PIN holds no lmgw_tag vX.Y.Z or unpublished" >&2; exit 1; }

# The lmgw crates the page needs, and what of lmgw-ui it links (the base components' stylesheet and
# the fonts it names; lmgw's chat-plane design §9.8: until the kit carries the base components).
CRATES=(lmgw-chat-ui lmgw-ui-kit lmgw-api-types lmgw-client)
EXTRA=(crates/lmgw-ui/assets/app.css crates/lmgw-ui/assets/fonts)
dest=$root/target/lmgw-pin

checkout() {
  if [[ -n "${1:-}" ]]; then realpath -m "$1"; return; fi
  if [[ -n "${LMGW_DIR:-}" ]]; then realpath -m "$LMGW_DIR"; return; fi
  local common
  common=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "$root/.git")
  realpath -m "$(dirname "$common")/../lmgw"
}

has_tree() { [[ "$(git -C "$1" cat-file -t "$tree" 2>/dev/null)" == tree ]]; }

# The paths of the pinned tree that are staged, for checkout $1.
staged_paths() {
  local c p
  for c in "${CRATES[@]}"; do
    git -C "$1" cat-file -e "$tree:crates/$c/Cargo.toml" 2>/dev/null \
      || { echo "lmgw's tree ${tree:0:12} has no crates/$c" >&2; return 1; }
    for p in Cargo.toml src assets; do
      if git -C "$1" cat-file -e "$tree:crates/$c/$p" 2>/dev/null; then echo "crates/$c/$p"; fi
    done
  done
  printf '%s\n' "${EXTRA[@]}"
}

# The staged crates' workspace root, from checkout $1: the staged crates alone, with lmgw's
# [workspace.package] (their version, edition and licence are inherited from it), as Kai's RPM
# stages them.
root_toml() {
  local c sep=""
  printf '# Staged by kai-firefox scripts/lmgw-pin.sh from lmgw tree %s (lmgw %s, %s).\n' "$tree" "$pin" "$tag"
  printf '[workspace]\nresolver = "2"\nmembers = ['
  for c in "${CRATES[@]}"; do printf '%s"crates/%s"' "$sep" "$c"; sep=", "; done
  printf ']\n\n'
  git -C "$1" show "$tree:Cargo.toml" | awk '/^\[workspace\.package\]/{p=1;print;next} /^\[/{p=0} p&&NF&&!/^#/'
}

case "${1:-}" in
  commit) echo "$pin" ;;
  tree) echo "$tree" ;;
  tag)
    [[ "$tag" != unpublished ]] || {
      echo "LMGW_PIN: lmgw_tag is unpublished: no published lmgw release has the pinned tree" \
        "${tree:0:12} (lmgw ${pin:0:7}) yet, so there is none to clone" >&2
      exit 1
    }
    echo "$tag"
    ;;
  verify-tree)
    lmgw=$(realpath -m "${2:?usage: $0 verify-tree <lmgw checkout>}")
    head=$(git -C "$lmgw" rev-parse --verify -q 'HEAD^{tree}' 2>/dev/null) \
      || { echo "LMGW_PIN: no lmgw checkout at $lmgw" >&2; exit 1; }
    [[ "$head" == "$tree" ]] || {
      echo "LMGW_PIN: lmgw at $lmgw has the tree $head, not the pinned $tree ($tag)" >&2
      exit 1
    }
    echo "lmgw at $lmgw has the pinned tree ${tree:0:12} ($tag)"
    ;;
  verify-published)
    fail() { echo "LMGW_PIN${at:+ at $at}: $*" >&2; exit 1; }
    [[ "$tag" != unpublished ]] \
      || fail "lmgw_tag is unpublished: lmgw ${pin:0:7} (tree ${tree:0:12}) is in no published lmgw" \
        "release yet, and GitHub's release build clones one. Publish lmgw first, then name its" \
        "release in LMGW_PIN"
    url=${LMGW_PUBLIC_URL:-https://github.com/lmgw-dev/lmgw}
    # --git-dir, never -C: a cache directory that is no repository must not send git up into this one.
    cache=$root/target/lmgw-public.git
    mkdir -p "$root/target"
    git init -q --bare "$cache"
    git --git-dir="$cache" fetch -q --depth 1 --no-tags "$url" "+refs/tags/$tag:refs/tags/$tag" \
      || fail "cannot fetch lmgw_tag $tag from $url: is it published?"
    public=$(git --git-dir="$cache" rev-parse "refs/tags/$tag^{tree}")
    [[ "$public" == "$tree" ]] \
      || fail "$url's $tag has the tree ${public:0:12}, not lmgw_tree ${tree:0:12}: the tag is" \
        "another release than the pinned source"
    echo "$url's $tag has the pinned tree ${tree:0:12}"
    ;;
  clone-published)
    dest=$(realpath -m "${2:?usage: $0 clone-published <dest>}")
    [[ "$tag" != unpublished ]] || {
      echo "LMGW_PIN${at:+ at $at}: lmgw_tag is unpublished: no published lmgw release has the pinned tree" \
        "${tree:0:12} (lmgw ${pin:0:7}), so GitHub's build has no lmgw to clone. Publish lmgw, then name" \
        "its release as lmgw_tag in LMGW_PIN." >&2
      exit 1
    }
    url=${LMGW_PUBLIC_URL:-https://github.com/lmgw-dev/lmgw}
    git clone --quiet --depth 1 --branch "$tag" "$url" "$dest" \
      || { echo "LMGW_PIN${at:+ at $at}: cannot clone lmgw $tag from $url" >&2; exit 1; }
    exec "${BASH_SOURCE[0]}" ${at:+--at "$at"} verify-tree "$dest"
    ;;
  check)
    lmgw=$(checkout "${2:-}")
    warn() { echo "warning (LMGW_PIN): $*" >&2; }
    if ! git -C "$lmgw" rev-parse --git-dir >/dev/null 2>&1; then
      warn "no lmgw checkout at $lmgw; the sidebar is pinned to lmgw ${pin:0:7} ($tag, tree ${tree:0:7})"
      exit 0
    fi
    has_tree "$lmgw" || warn "lmgw at $lmgw lacks the pinned tree ${tree:0:12} (lmgw ${pin:0:7}): git -C $lmgw fetch"
    if git -C "$lmgw" cat-file -e "$pin^{commit}" 2>/dev/null \
      && [[ "$(git -C "$lmgw" rev-parse "$pin^{tree}")" != "$tree" ]]; then
      warn "lmgw_commit ${pin:0:7}'s tree is not lmgw_tree ${tree:0:7}: LMGW_PIN's lines must name one source"
    fi
    ;;
  stage)
    lmgw=$(checkout "${2:-}")
    if [[ -f "$dest/.tree" && "$(<"$dest/.tree")" == "$tree" ]]; then
      echo "lmgw ${tree:0:12} is staged in $dest"
      exit 0
    fi
    has_tree "$lmgw" || {
      echo "the pinned lmgw tree $tree (LMGW_PIN, lmgw ${pin:0:7}) is not in $lmgw: fetch it there," \
        "or name a checkout that has it (LMGW_DIR)" >&2
      exit 1
    }
    listed=$(staged_paths "$lmgw")
    mapfile -t paths <<<"$listed"
    tmp=$dest.tmp
    rm -rf "$tmp"
    mkdir -p "$tmp"
    git -C "$lmgw" archive --format=tar "$tree" -- "${paths[@]}" | tar -xf - -C "$tmp"
    root_toml "$lmgw" >"$tmp/Cargo.toml"
    echo "$tree" >"$tmp/.tree"
    rm -rf "$dest"
    mv "$tmp" "$dest"
    echo "staged lmgw ${tree:0:12} (lmgw ${pin:0:7}, $tag) from $lmgw in $dest"
    ;;
  verify-staged)
    lmgw=$(checkout "${2:-}")
    [[ -f "$dest/.tree" && "$(<"$dest/.tree")" == "$tree" ]] \
      || { echo "$dest is not staged from the pinned lmgw tree ${tree:0:12}: run $0 stage" >&2; exit 1; }
    has_tree "$lmgw" || {
      echo "cannot check $dest: the pinned lmgw tree $tree is not in $lmgw (fetch it there, or name a checkout" \
        "that has it: LMGW_DIR)" >&2
      exit 1
    }
    listed=$(staged_paths "$lmgw")
    mapfile -t paths <<<"$listed"
    # "<blob> <path>" for every file, as the tree has them and as they are on disk.
    want=$(git -C "$lmgw" ls-tree -r "$tree" -- "${paths[@]}" | awk -F'\t' '{split($1, a, " "); print a[3] " " $2}' | LC_ALL=C sort)
    # (git hash-object takes the paths as absolute ones: inside a repository it reads relative
    # paths from its top, not from here.)
    files=$(cd "$dest" && find crates -type f | LC_ALL=C sort)
    have=$(paste -d' ' <(sed "s|^|$dest/|" <<<"$files" | git hash-object --no-filters --stdin-paths) <(echo "$files") | LC_ALL=C sort)
    if [[ "$want" != "$have" ]]; then
      echo "$dest differs from the pinned lmgw tree ${tree:0:12} (- the tree, + on disk); run $0 stage after removing it:" >&2
      differ=$(diff <(echo "$want") <(echo "$have") | sed -n 's/^</-/p; s/^>/+/p' || true)
      sed -n 1,20p <<<"$differ" >&2
      n=$(wc -l <<<"$differ")
      if ((n > 20)); then echo "($n lines)" >&2; fi
      exit 1
    fi
    cmp -s <(root_toml "$lmgw") "$dest/Cargo.toml" \
      || { echo "$dest/Cargo.toml is not the workspace root $0 stage writes" >&2; exit 1; }
    echo "$dest holds the pinned lmgw tree ${tree:0:12}: $(wc -l <<<"$files") files"
    ;;
  *)
    echo "usage: $0 [--at REF] stage [lmgw checkout] | check [lmgw checkout] | verify-staged [lmgw checkout] | verify-tree <lmgw checkout> | verify-published | clone-published <dest> | commit | tag | tree" >&2
    exit 2
    ;;
esac
