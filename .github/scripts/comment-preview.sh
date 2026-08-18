#!/usr/bin/env bash
# Leave one comment on the pull request pointing at its preview, and keep
# editing that same comment on later pushes rather than adding another.
set -euo pipefail

: "${PR:?}" "${URL:?}" "${GH_TOKEN:?}"
marker='<!-- docs-preview -->'
body="${marker}
📖 **Docs preview:** ${URL}

Built from $(git rev-parse --short HEAD 2>/dev/null || echo 'this run'). Updated on every push; removed when this pull request closes."

existing="$(gh api "repos/${GITHUB_REPOSITORY}/issues/${PR}/comments" --paginate \
  --jq "[.[] | select(.body | contains(\"${marker}\"))] | first | .id // empty")"

if [ -n "$existing" ]; then
  gh api -X PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${existing}" -f body="$body" >/dev/null
  echo "updated comment ${existing}"
else
  gh api -X POST "repos/${GITHUB_REPOSITORY}/issues/${PR}/comments" -f body="$body" >/dev/null
  echo 'posted preview comment'
fi
echo "$body" >> "$GITHUB_STEP_SUMMARY"
