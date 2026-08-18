#!/usr/bin/env bash
# Remove previews whose pull request is no longer open.
#
#   PAGES_DIR=pages bash .github/scripts/prune-previews.sh
#
# Reconciles rather than reacts. Deleting on the "closed" event alone lost
# previews two ways: a close event never fired (the workflow's paths filter, or
# a cancelled run), and a preview job still in flight pushed its directory
# *after* the cleanup had already looked. Asking "which of these is still open?"
# is immune to both, and to whatever the next surprise is.
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
pages="${PAGES_DIR:-pages}"
cd "$pages"

[ -d previews ] || { echo 'no previews directory'; exit 0; }

removed=()
for dir in previews/pr-*; do
  [ -d "$dir" ] || continue
  number="${dir##*/pr-}"
  state="$(gh pr view "$number" --repo "$GITHUB_REPOSITORY" --json state --jq .state 2>/dev/null || echo UNKNOWN)"
  case "$state" in
    OPEN)
      echo "keep    $dir (open)"
      ;;
    UNKNOWN)
      # never delete on a failed lookup: a rate limit is not a closed pull request
      echo "skip    $dir (could not read #${number})"
      ;;
    *)
      echo "remove  $dir (${state})"
      git rm -rq "$dir"
      removed+=("#${number}")
      ;;
  esac
done

if [ ${#removed[@]} -eq 0 ]; then
  echo 'nothing to prune'
  exit 0
fi

git config user.name 'github-actions[bot]'
git config user.email 'github-actions[bot]@users.noreply.github.com'
git commit -qm "docs: drop previews for ${removed[*]}"
for attempt in 1 2 3; do
  if git push -q origin HEAD:gh-pages; then
    echo "pruned ${removed[*]}"
    exit 0
  fi
  git pull -q --rebase origin gh-pages
done
echo 'could not push gh-pages after three attempts' >&2
exit 1
