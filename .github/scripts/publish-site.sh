#!/usr/bin/env bash
# Put a built site into $TARGET on the gh-pages branch and push it.
#
#   TARGET=.                 the main site
#   TARGET=previews/pr-42    one pull request's preview
#   PAGES_DIR=pages          a checkout of gh-pages (default "pages")
#   INCOMING=incoming        the built site to publish (default "incoming")
#
# The main site is the root of the branch and previews are directories under
# it, so replacing either must leave the other alone: publishing main wipes the
# root but keeps previews/, and a preview only ever touches its own folder.
#
# Note the two directories: this script lives in the *repository*, while the
# content it commits lives in a *separate checkout* of gh-pages. Running it
# from a gh-pages checkout cannot work — that branch holds a built site and
# nothing else.
set -euo pipefail

target="${TARGET:?TARGET is required}"
incoming="$(cd "${INCOMING:-incoming}" && pwd)"
pages="${PAGES_DIR:-pages}"

mkdir -p "$pages"
cd "$pages"

if [ ! -d .git ]; then
  # no branch upstream yet, so actions/checkout had nothing to fetch
  git init -q
  git remote add origin "https://x-access-token:${GH_TOKEN:?GH_TOKEN is required for a first publish}@github.com/${GITHUB_REPOSITORY}"
  git switch -q --orphan gh-pages
fi

git config user.name 'github-actions[bot]'
git config user.email 'github-actions[bot]@users.noreply.github.com'

if [ "$target" = '.' ]; then
  # keep previews/ and .git, replace everything else
  find . -mindepth 1 -maxdepth 1 -not -name .git -not -name previews -exec rm -rf {} +
  cp -R "$incoming"/. .
else
  rm -rf "$target"
  mkdir -p "$target"
  cp -R "$incoming"/. "$target/"
fi

# Pages would otherwise run the branch through Jekyll and drop directories
# whose names begin with an underscore
touch .nojekyll

git add -A
if git diff --cached --quiet; then
  echo "no change to publish for ${target}"
  exit 0
fi
git commit -qm "docs: publish ${target}"

# another job may have pushed between the checkout and now
for attempt in 1 2 3; do
  if git push -q origin HEAD:gh-pages; then
    echo "published ${target}"
    exit 0
  fi
  echo "push rejected (attempt ${attempt}) — rebasing on the remote"
  git pull -q --rebase origin gh-pages
done
echo 'could not push gh-pages after three attempts' >&2
exit 1
