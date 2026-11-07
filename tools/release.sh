#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Tag the current commit of main and publish a GitHub release with the
# extension zip attached.
#
# Usage: tools/release.sh [--dry-run] VERSION [NOTES]
#
#   --dry-run  Run every check and build the zip, then stop before tagging.
#   VERSION    New version as X.Y.Z, higher than the latest tag.
#   NOTES      Release notes. GitHub generates them when omitted.

set -euo pipefail

EXTRA_SOURCES=(icons)

die() {
    echo "error: $*" >&2
    exit 1
}

usage() {
    sed -n '7,11s/^# \{0,1\}//p' "$0"
    exit "$1"
}

dry_run=false
if [[ ${1:-} == --dry-run ]]; then
    dry_run=true
    shift
fi
[[ ${1:-} == -h || ${1:-} == --help ]] && usage 0
[[ $# -ge 1 && $# -le 2 ]] || usage 1

version=$1
notes=${2:-}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must look like 1.2.3, got '$version'"

cd "$(dirname "$0")/.."

uuid=$(sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' metadata.json)
[[ -n $uuid ]] || die "could not read uuid from metadata.json"
zip_name="$uuid.shell-extension.zip"

for tool in git gnome-extensions npm unzip; do
    command -v "$tool" >/dev/null || die "$tool is not installed"
done
if ! $dry_run; then
    command -v gh >/dev/null || die "gh is not installed"
    gh auth status >/dev/null 2>&1 || die "gh is not logged in, run: gh auth login"
fi

[[ $(git branch --show-current) == main ]] || die "switch to main first"
[[ -z $(git status --porcelain) ]] || die "commit or stash your changes first"

git fetch --quiet --tags origin main
[[ $(git rev-parse HEAD) == $(git rev-parse origin/main) ]] \
    || die "local main differs from origin/main, merge your changes and pull first"

git rev-parse --quiet --verify "refs/tags/$version" >/dev/null \
    && die "tag $version already exists"

latest=$(git tag --list '[0-9]*.[0-9]*.[0-9]*' --sort=-version:refname | head -n 1)
if [[ -n $latest ]]; then
    highest=$(printf '%s\n%s\n' "$latest" "$version" | sort -V | tail -n 1)
    [[ $highest == "$version" ]] || die "$version is not higher than the latest tag $latest"
fi

npm run --silent lint || die "lint failed"

# Build from a clean export so only committed files can reach the zip.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/src" "$work/out"
git archive HEAD | tar -x -C "$work/src"

pack_args=(--force --out-dir="$work/out")
for source in "${EXTRA_SOURCES[@]}"; do
    pack_args+=(--extra-source="$source")
done
(cd "$work/src" && gnome-extensions pack "${pack_args[@]}" .)
zip="$work/out/$zip_name"

# Every shipped file must be in the zip, or the extension breaks for users.
listing=$(unzip -Z1 "$zip")
while IFS= read -r file; do
    grep -qxF "$file" <<<"$listing" || die "$file is missing from the zip"
done < <(echo extension.js; echo metadata.json; git ls-files -- "${EXTRA_SOURCES[@]}")

commit=$(git rev-parse --short HEAD)
echo "Version: $version (previous: ${latest:-none})"
echo "Commit:  $commit $(git log -1 --format=%s)"
echo "Zip contents:"
sed 's/^/  /' <<<"$listing"

if $dry_run; then
    echo "Dry run: nothing was tagged or published."
    exit 0
fi

read -r -p "Publish release $version? [y/N] " answer
[[ $answer == y || $answer == Y ]] || die "cancelled"

git tag -a "$version" -m "$version"
git push --quiet origin "refs/tags/$version" || {
    git tag -d "$version" >/dev/null
    die "could not push tag $version"
}

if [[ -n $notes ]]; then
    notes_args=(--notes "$notes")
else
    notes_args=(--generate-notes)
fi

gh release create "$version" "$zip" --verify-tag --latest --title "$version" "${notes_args[@]}" || {
    echo "error: tag $version was pushed but the release failed." >&2
    echo "Remove the tag, then run this script again:" >&2
    echo "  git push origin :refs/tags/$version && git tag -d $version" >&2
    exit 1
}

echo
echo "Next: download $zip_name from the release above and upload it to"
echo "https://extensions.gnome.org/upload/"
