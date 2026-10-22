#!/bin/sh
set -eu
# Xcode Release may be invoked without npm. Reject stale local-mode assets too.
if [ "${CONFIGURATION:-}" != "Release" ]; then exit 0; fi
metadata="${SRCROOT}/App/public/ios-build.json"
mode=$(/usr/bin/plutil -extract mode raw -o - "$metadata")
origin=$(/usr/bin/plutil -extract apiOrigin raw -o - "$metadata")
if [ "$mode" != "ios" ] || [ "$origin" != "https://vocab-trainer-frontend-839843597381.asia-northeast1.run.app" ]; then
  echo "error: Run npm run ios:sync before a Release build. Local API assets cannot ship."
  exit 1
fi
