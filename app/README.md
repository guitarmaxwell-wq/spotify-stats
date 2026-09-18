# Crates — Expo client

The app half of the project (workstream 2). A shelf of milk crates holding the
records you have earned: an album only appears once every track on it has been
played. Expo + React Native + TypeScript, so the same code runs on web for fast
iteration and on iOS via Expo Go / EAS / TestFlight later.

## Requirements

- Node.js 20+ (this machine has 24 LTS at `C:\Program Files\nodejs`; if `node`
  is not on your PATH, prepend that directory).

## Run on web

```bash
cd app
npm install          # first time only
npm run web          # = npx expo start --web, serves http://localhost:8081
```

Open http://localhost:8081. The shelf is the home screen.

## Run on a phone (Expo Go)

1. Install **Expo Go** from the App Store / Play Store.
2. `cd app && npx expo start` (no `--web`).
3. Phone and computer must be on the same Wi-Fi. Scan the QR code from the
   terminal with the Camera app (iOS) or from inside Expo Go (Android).
   - If the phone cannot reach the dev server (corporate Wi-Fi, VPN), run
     `npx expo start --tunnel` instead.

## Later: TestFlight

`npx eas build -p ios` and `npx eas submit` are the path, but they require an
Apple Developer Program membership ($99/yr) under your own Apple ID, plus
certificate creation and App Store Connect setup. Those steps are yours to do;
the bundle identifier is already set to `com.maxwell.crates` in `app.json`.

## Screens

- **Shelf** (`src/screens/ShelfScreen.tsx`) — vertical scroll of wooden planks,
  two or three crates per shelf (three on wide viewports). Each crate is a
  genre: the front record faces out, the top edges of the records filed behind
  it stack up above it, and the crate's front panel with its label overlaps the
  lower half. Tap a crate to open it.
- **Crate** (`src/screens/CrateDetailScreen.tsx`) — flipping through a crate.
  Records are laid front-to-back, each rotated back on the Y axis so you see it
  edge-on; tap once to bring a record forward, tap the front record (or "Pull it
  out") to open the album sheet.
- **Stats** (`src/screens/StatsScreen.tsx`) — totals, date range, plays/day,
  top artists, top albums, crates by size, unresolved count.
- **Almost there** (`src/screens/AlmostThereScreen.tsx`) — not-yet-unlocked
  albums sorted by fewest tracks remaining, each listing the missing tracks.

Navigation is a `useState` route switch in `App.tsx` — no navigation library.
That is deliberate for now (three screens, one modal); swap in
`@react-navigation/native` when deep links or a tab bar are needed.

## Data

`src/data/collection.ts` is the only module that knows where data comes from:

```ts
const SOURCE = mock as unknown as Collection;   // <- the one line to change
export function loadCollection(): Collection { return SOURCE; }
```

Today it loads `src/data/mockCollection.json` (45 albums, 11 genres, 20
unlocked, 25 in progress, 5 unresolved) which conforms exactly to the
`data/collection.json` schema in `docs/SPEC.md`. When the pipeline produces the
real file, point that import at it (or fetch it) and nothing else changes.
`src/types.ts` mirrors the schema.

### Covers

`cover_url` is assumed missing most of the time. `src/components/RecordSleeve.tsx`
draws a typographic sleeve — artist in letterspaced caps, title large, a printed
band and rule, the year — on a color derived from a hash of `album.id`, in one
of three layouts, with a sliver of black vinyl peeking out the right edge. When
`cover_url` *is* present it is used, and an image load error falls back to the
generated sleeve, so a dead cover-art URL never leaves a hole.

## Assumptions made where the spec was silent

- `unlocked_at` is `null` for albums that are not unlocked (the spec only shows
  the unlocked case).
- `missing_tracks` holds plain track-title strings, possibly with suffixes like
  `" - Remastered"`, and is empty for unlocked albums.
- `release_year` may be null (pre-1900 / unknown releases are common in a
  MusicBrainz-derived set); the sleeve omits it rather than printing `null`.
- A `genre_id` that appears on an album but not in `genres` still gets a crate,
  labelled with the raw id. The spec does not promise the two lists agree.
- `completion` is trusted for sorting; the "9 of 11" labels are recomputed from
  `played_tracks` / `total_tracks` so a disagreement shows up as a visible bug
  rather than silently.
- `unresolved[].reason` is treated as an opaque string; only the count is shown.
