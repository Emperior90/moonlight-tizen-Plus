#!/usr/bin/env bash
# Checks that the repository can take the bug reports that the README, the guide, the release notes and the Support
# dialog of the app ask for, before the release workflows publish a release:
# - Issues must be turned on (Settings -> General -> Features -> Issues). With Issues off, the links to the issue tracker
#   of this fork lead to a 404 page.
# - The default branch must have the issue forms and the guide. GitHub shows only the issue forms of the default branch,
#   and the links to blob/HEAD/docs/GUIDE.md (the issue forms and the QR code of the Support dialog of the app) open the
#   guide of the default branch.
#
# Environment: API_URL (https://api.github.com/repos/<owner>/<repo>) and GITHUB_TOKEN. With SUPPORT_CHECK_MODE=warn it
# reports the problems as warnings of the workflow run and succeeds, otherwise it fails when it finds one.
# Usage: bash .github/scripts/check-support-path.sh
set -euo pipefail

REQUIRED_FILES=(".github/ISSUE_TEMPLATE/bug.yml" ".github/ISSUE_TEMPLATE/config.yml" "docs/GUIDE.md")
mode="${SUPPORT_CHECK_MODE:-error}"
problems=()

# Calls the GitHub API, writes the response to the file and prints the HTTP status
api_status() {
  curl -sSL -o "$1" -w '%{http_code}' -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.v3+json" "$2"
}

response=$(mktemp)
trap 'rm -f "$response"' EXIT

status=$(api_status "$response" "$API_URL")
if [ "$status" != "200" ]; then
  echo "Unexpected status $status while reading the repository: $(cat "$response")" >&2
  exit 1
fi
has_issues=$(jq -r '.has_issues' "$response")
default_branch=$(jq -r '.default_branch' "$response")

if [ "$has_issues" != "true" ]; then
  problems+=("Issues are turned off for this repository, but the README, the guide, the release notes and the Support dialog of the app send users to its issue tracker. Turn them on in Settings -> General -> Features -> Issues.")
fi

for file in "${REQUIRED_FILES[@]}"; do
  status=$(api_status "$response" "$API_URL/contents/$file?ref=$default_branch")
  if [ "$status" = "404" ]; then
    problems+=("The default branch $default_branch has no $file. GitHub shows only the issue forms of the default branch, and the links to blob/HEAD/docs/GUIDE.md open its guide: merge the branch of this release into $default_branch, or make it the default branch.")
  elif [ "$status" != "200" ]; then
    echo "Unexpected status $status while looking up $file on $default_branch: $(cat "$response")" >&2
    exit 1
  fi
done

if [ "${#problems[@]}" -eq 0 ]; then
  echo "The issue tracker is turned on, and the default branch $default_branch has the issue forms and the guide."
  exit 0
fi
for problem in "${problems[@]}"; do
  if [ "$mode" = "warn" ]; then
    echo "::warning::$problem"
  else
    echo "::error::$problem"
  fi
done
if [ "$mode" = "warn" ]; then
  exit 0
fi
exit 1
