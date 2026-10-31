#!/bin/bash
# Dev helper: screenshot a page of the running app with headless Edge.
# usage: scripts/shot.sh "<route e.g. leads or lead/LEAD-2026-000010>" <role> <out.png> [width] [height] [theme]
# roles: prospect | ops | agent | analyst | admin   (server must be running on :8000)
OUT="$3"; W="${4:-1500}"; H="${5:-1100}"; PROFILE="$(mktemp -d)"
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$PROFILE" --window-size=$W,$H --virtual-time-budget=12000 --screenshot="$OUT" "http://127.0.0.1:8000/?role=$2&theme=${6:-dark}#/$1" >/dev/null 2>&1
rm -rf "$PROFILE"
