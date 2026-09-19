# Placeholder reward art

Generates the sticker, community-pass and poster art that `rewards.art_url`
points at. Everything here is **original placeholder art**: type, shapes and
colour only. No band logo or album artwork is traced, embedded or fetched. An
album's extracted colour *palette* (`data/collection.json`) is used, and a
palette is not artwork.

## Generate

```sh
venv/Scripts/python.exe tools/stickers/generate.py               # manifest.json -> out/reward-art/
venv/Scripts/python.exe tools/stickers/generate.py --samples 12  # + top shelf artists -> out/samples/
venv/Scripts/python.exe tools/stickers/generate.py --png         # + PNGs (headless Chrome/Edge) -> out/preview/
```

Output is deterministic: same inputs, byte-identical SVGs. `out/` is generated
and git-ignored.

What gets drawn:

| kind | what it is |
|---|---|
| `artist` | artist name in heavy type, one of four layouts (badge, banner, circle, starburst) chosen by a hash of the name, coloured from that artist's albums on the shelf |
| `artist-template` | the same, with an empty `ARTIST NAME` slot, for wildcard rules |
| `number` | a band number as the hero (blink-182 · 182), artist name on a ribbon |
| `community` | a backstage laminate: lanyard slot, ALL ACCESS header, barcode. Reads as access, not decoration |
| `poster` | portrait print, taped up, geometry from the album palette |

Every piece is wrapped as a sticker: a die-cut white border, a soft drop
shadow, a slight tilt, and often a peeling corner.

## Upload

`manifest.json` lists each file's path **inside the `reward-art` bucket**, and
`rewards.art_url` is that bucket's public URL for the same path:

```
https://<project>.supabase.co/storage/v1/object/public/reward-art/<path>
```

```sh
bash tools/stickers/upload.sh            # upload anything not in the bucket yet
REPLACE=1 bash tools/stickers/upload.sh  # also overwrite what is already there
```

The script uses the Supabase CLI's own login (`supabase login` + `supabase
link`); it never reads, prints or stores a key. It touches only the paths in
`manifest.json`. `storage cp` will not overwrite (409 `KeyAlreadyExists`), so
`REPLACE=1` removes the object first.

The bucket's client write policy is admins-only (`reward_art_admin_insert`, in
`20260919000000_rewards_core.sql`); the CLI path is separate from it and works
with the project owner's login. If that ever stops working, do not work around
the policy: the generated files are in `tools/stickers/out/reward-art/`, and an
admin can upload that tree to the same paths from the dashboard.

## Replacing a placeholder with real art

Put the real file at the same bucket path and run `REPLACE=1
tools/stickers/upload.sh` (or upload it from the dashboard). No row changes, no
code changes. The generator does not need to know that art is now real; drop the
entry from `manifest.json` so a re-run cannot overwrite it.

## Adding a reward

1. Add an entry to `manifest.json` (`kind`, `name`/`number` as the kind needs,
   and the bucket `path`).
2. Re-run `generate.py`, then `upload.sh`.
3. Add the `rewards` row (and its `rules` row) in a migration, with `art_url`
   set to the public URL of that path. The current seed is
   `supabase/migrations/20260919050000_seed_rewards.sql`.
