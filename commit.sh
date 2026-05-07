#!/bin/bash

if [ -z "$1" ]; then
  echo "Usage: ./commit.sh <message> [branch]"
  exit 1
fi

MESSAGE="$1"
BRANCH="${2:-master}"

if ! git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git checkout -b "$BRANCH"
fi

git add .
git commit -m "$MESSAGE"
git push origin "$BRANCH"
