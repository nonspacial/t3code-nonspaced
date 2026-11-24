#!/bin/sh
# Regenerates the fixtures with a private Blender config, scripts and temp folder, so neither
# the developer's Blender settings nor add-ons touch them: make-fixtures.sh <blender> <suffix>.
set -eu
blender=$1
suffix=$2
isolated=$(mktemp -d)
trap 'rm -rf "$isolated"' EXIT
mkdir -p "$isolated/config" "$isolated/scripts" "$isolated/resources" "$isolated/tmp"
BLENDER_USER_CONFIG="$isolated/config" \
  BLENDER_USER_SCRIPTS="$isolated/scripts" \
  BLENDER_USER_RESOURCES="$isolated/resources" \
  TMPDIR="$isolated/tmp" \
  "$blender" -b --factory-startup --disable-autoexec \
  --python "$(dirname "$0")/make-fixtures.py" -- "$suffix"
