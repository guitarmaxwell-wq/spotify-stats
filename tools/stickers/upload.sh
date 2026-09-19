#!/usr/bin/env bash
# Upload every file listed in tools/stickers/manifest.json to the reward-art
# bucket, at the same path the seed migration's art_url points at.
#
# Uses the Supabase CLI's own login (`supabase login` + `supabase link`). This
# script never reads, prints or stores a key. Run it from anywhere, after
# generate.py:
#
#   venv/Scripts/python.exe tools/stickers/generate.py
#   bash tools/stickers/upload.sh              # upload files not yet in the bucket
#   REPLACE=1 bash tools/stickers/upload.sh    # also overwrite ones that are
#
# `storage cp` refuses to overwrite (409 KeyAlreadyExists), so REPLACE=1 removes
# the object first and uploads again. That is also how real art replaces a
# placeholder: put the new file at the same path and run with REPLACE=1. Only
# paths listed in the manifest are ever touched.
set -euo pipefail

cd "$(dirname "$0")/../.."
SUPABASE=./node_modules/.bin/supabase
SRC=tools/stickers/out/reward-art
PY=venv/Scripts/python.exe
[ -x "$PY" ] || PY=python3

existing=$("$SUPABASE" storage ls -r ss:///reward-art/ --experimental --linked </dev/null)

paths=$("$PY" -c 'import json,sys; [print(e["path"]) for e in json.load(open(sys.argv[1], encoding="utf-8"))["art"]]' \
  tools/stickers/manifest.json | tr -d '\r')

for path in $paths; do
  # Both formats go up: the PNG is what the app shows (React Native's <Image>
  # cannot render SVG), the SVG is the source for web and print.
  for file in "$path" "${path%.svg}.png"; do
    case "$file" in
      *.png) type=image/png ;;
      *)     type=image/svg+xml ;;
    esac
    if [ ! -f "$SRC/$file" ]; then
      echo "missing $SRC/$file (run generate.py first)" >&2
      exit 1
    fi
    if printf '%s' "$existing" | grep -qF "\"/reward-art/$file\""; then
      if [ "${REPLACE:-0}" != "1" ]; then
        echo "exists   reward-art/$file (REPLACE=1 to overwrite)"
        continue
      fi
      "$SUPABASE" storage rm "ss:///reward-art/$file" --experimental --linked --yes </dev/null >/dev/null
    fi
    "$SUPABASE" storage cp "$SRC/$file" "ss:///reward-art/$file" \
      --experimental --linked --content-type "$type" --cache-control "max-age=300" \
      </dev/null >/dev/null
    echo "uploaded reward-art/$file"
  done
done
