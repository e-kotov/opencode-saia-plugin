#!/usr/bin/env bash
set -euo pipefail

# Bump package.json and package-lock.json, commit the version, and tag it.
# Usage: bash prepare-release.sh [major|minor|patch|version_number]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    echo "Error: commit or stash tracked changes before preparing a release." >&2
    exit 1
fi

CURRENT_VERSION="$(node -p 'require("./package.json").version')"
case "${1:-patch}" in
    major)
        NEW_VERSION="$(node -e 'const [a]=process.argv[1].split("."); console.log(`${Number(a)+1}.0.0`)' "$CURRENT_VERSION")"
        ;;
    minor)
        NEW_VERSION="$(node -e 'const [a,b]=process.argv[1].split("."); console.log(`${a}.${Number(b)+1}.0`)' "$CURRENT_VERSION")"
        ;;
    patch)
        NEW_VERSION="$(node -e 'const [a,b,c]=process.argv[1].split("."); console.log(`${a}.${b}.${Number(c)+1}`)' "$CURRENT_VERSION")"
        ;;
    *)
        NEW_VERSION="$1"
        ;;
esac

if [[ ! "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Error: version must use major.minor.patch format; got $NEW_VERSION" >&2
    exit 1
fi

TAG="v$NEW_VERSION"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    echo "Error: tag $TAG already exists." >&2
    exit 1
fi

BRANCH="$(git branch --show-current)"
if [[ -z "$BRANCH" ]]; then
    echo "Error: prepare a release from a named branch, not detached HEAD." >&2
    exit 1
fi

echo "Current version: $CURRENT_VERSION"
echo "New version:     $NEW_VERSION"
node - "$NEW_VERSION" <<'NODE'
const fs = require("node:fs")
const version = process.argv[2]
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"))
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"))
packageJson.version = version
lock.version = version
lock.packages[""].version = version
fs.writeFileSync("package.json", `${JSON.stringify(packageJson, null, 2)}\n`)
fs.writeFileSync("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`)
NODE
git add package.json package-lock.json
git commit -m "chore: bump version to $NEW_VERSION"
git tag -a "$TAG" -m "Release $TAG"

echo "Prepared $TAG. Push the commit and tag to GitHub to run release checks:"
echo "  git push origin $BRANCH"
echo "  git push origin $TAG"
