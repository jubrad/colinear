#!/usr/bin/env bash
# Put a built site into $TARGET on the gh-pages branch and push it.
#
#   TARGET=.                       the main site
#   TARGET=previews/pr-42          one pull request's preview
#
# The main site is the root of the branch and previews are directories under
# it, so replacing either one must leave the other alone: publishing main wipes
# the root but keeps previews/, and a preview only ever touches its own folder.
set -euo pipefail

target="${TARGET:?TARGET is required}"
incoming="${INCOMING:-incoming}"
[ -d "$incoming" ] || { echo "nothing to publish: $incoming does not exist" >&2; exit 1; }

# a first run has no branch yet
if [ ! -d .git ]; then
  echo 'not a git checkout — the gh-pages checkout step must run first' >&2
  exit 1
fi
git switch gh-pages 2>/dev/null || git switch --orphan gh-pages

git config user.name 'github-actions[bot]'
git config user.email 'github-actions[bot]@users.noreply.github.com'

if [ "$target" = '.' ]; then
  # keep previews/ and .git, replace everything else
  find . -mindepth 1 -maxdepth 1 \
    -not -name .git -not -name previews -not -name incoming \
    -exec rm -rf {} +
  cp -R "$incoming"/. .
else
  rm -rf "$target"
  mkdir -p "$target"
  cp -R "$incoming"/. "$target/"
fi
rm -rf "$incoming"

# Pages would otherwise run the branch through Jekyll and drop directories
# whose names begin with an underscore
touch .nojekyll

git add -A
if git diff --cached --quiet; then
  echo 'no change to publish'
  exit 0
fi
git commit -qm "docs: publish ${target}"

# another job may have pushed between our checkout and now
for attempt in 1 2 3; do
  if git push -q origin gh-pages; then
    echo "published ${target}"
    exit 0
  fi
  echo "push rejected (attempt ${attempt}) — rebasing on the remote"
  git pull -q --rebase origin gh-pages
done
echo 'could not push gh-pages after three attempts' >&2
exit 1
