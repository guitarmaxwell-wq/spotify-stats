/**
 * Link your listening history.
 *
 * The design brief for this screen is honesty. Each of the three paths solves a
 * different part of the problem and each has a limit the user will otherwise
 * discover as a bug:
 *
 *  - **Last.fm** is the only one that both backfills and keeps up. It needs the
 *    user to have been scrobbling; someone who has never used it starts empty.
 *  - **Spotify sign-in** keeps the shelf filling from today. It cannot import a
 *    single past play — the API has no historical endpoint. It is also capped
 *    at 25 allowlisted testers, so it is not offered as the default path.
 *  - **Spotify export** is the only full Spotify backfill, and it is a manual
 *    download that can take up to 30 days to arrive.
 *
 * None of that is hidden behind a "learn more". Presenting Spotify sign-in as
 * though it fills a shelf would be the single most misleading thing this app
 * could do.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import TopBar from '../components/TopBar';
import { theme } from '../theme';
import {
  LASTFM_SETUP_HINT,
  PlayStore,
  SPOTIFY_SETUP_HINT,
  isLastfmConfigured,
  isSpotifyConfigured,
  isPersistent,
  PERSISTENCE_WARNING,
  lastfm,
  loadSpotifyTokens,
  spotify,
  spotifyImport,
  type SourceId,
  type StoreStats,
  type SyncResult,
} from '../link';

const day = (ts: number) =>
  ts ? new Date(ts * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

type Busy = { source: SourceId; message: string } | null;

export default function LinkScreen({ onBack }: { onBack: () => void }) {
  const [store, setStore] = useState<PlayStore | null>(null);
  const [stats, setStats] = useState<StoreStats | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [username, setUsername] = useState('');
  const [spotifyLinked, setSpotifyLinked] = useState(false);

  const refresh = useCallback((s: PlayStore) => setStats(s.stats()), []);

  useEffect(() => {
    let alive = true;
    (async () => {
      // A failure here used to leave the screen on its spinner forever with no
      // explanation. Surface it instead: an unusable store is worth saying out
      // loud, and the three options below still work without one.
      try {
        const s = await new PlayStore().load();
        const tokens = await loadSpotifyTokens();
        if (!alive) return;
        setStore(s);
        setStats(s.stats());
        setSpotifyLinked(Boolean(tokens));
      } catch (e) {
        if (alive) setError(`Could not open your play store: ${e instanceof Error ? e.message : e}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const auth = spotify.useSpotifyAuth(
    useCallback(() => {
      setSpotifyLinked(true);
      setError(null);
    }, []),
  );

  const run = useCallback(
    async (source: SourceId, message: string, fn: () => Promise<SyncResult | null>) => {
      setError(null);
      setResult(null);
      setBusy({ source, message });
      try {
        const r = await fn();
        if (r) setResult(r);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
        if (store) refresh(store);
      }
    },
    [store, refresh],
  );

  // ---------------------------------------------------------------- actions --

  const syncLastfm = () => {
    const name = username.trim();
    if (!name || !store) return;
    run('lastfm', 'Checking that user exists…', async () => {
      const info = await lastfm.checkUser(name);
      const cursor = store.cursor('lastfm');
      const full = !cursor.last_ts;
      if (full && info.playcount > 20000) {
        setBusy({
          source: 'lastfm',
          message: `Backfilling ${info.playcount.toLocaleString()} scrobbles — this takes a few minutes.`,
        });
      }
      return lastfm.sync(name, cursor, {
        full,
        onPage: (page, total) =>
          setBusy({ source: 'lastfm', message: `Page ${page} of ${total}…` }),
        persist: (events) => store.persist(events),
        commitCursor: async (lastTs) => {
          store.advanceCursor('lastfm', { lastTs, syncedAt: Math.floor(Date.now() / 1000) });
          await store.saveState();
        },
      });
    });
  };

  const syncSpotify = () => {
    if (!store) return;
    run('spotify_recent', 'Checking what you have played…', async () => {
      const cursor = store.cursor('spotify_recent');
      const page = await spotify.fetchRecent(cursor);
      const gap = spotify.suspectsGap(page, cursor);
      const { added, duplicates } = await store.commit('spotify_recent', page.events, {
        lastTs: Math.floor(page.highWaterMs / 1000),
        gap,
      });
      return spotify.summarize(page, cursor, added, duplicates);
    });
  };

  const importExport = () => {
    if (!store) return;
    run('spotify_export', 'Reading your export…', async () => {
      const r = await spotifyImport.pickAndImport({
        persist: (events) => store.persist(events),
        onFile: (name, i, total) =>
          setBusy({ source: 'spotify_export', message: `Reading ${name} (${i}/${total})…` }),
      });
      if (r) {
        store.advanceCursor('spotify_export', { syncedAt: Math.floor(Date.now() / 1000) });
        await store.saveState();
      }
      return r;
    });
  };

  const unlinkSpotify = async () => {
    await spotify.unlinkSpotify();
    setSpotifyLinked(false);
  };

  // ------------------------------------------------------------------- view --

  const lastfmCursor = store?.cursor('lastfm');
  const spotifyCursor = store?.cursor('spotify_recent');

  return (
    <ScrollView style={styles.room} contentContainerStyle={{ paddingBottom: 56 }}>
      {/* TopBar carries its own 18pt gutter, so this wrapper only supplies the
          shared max-width and centring — otherwise the header sits hard against
          the left edge while the cards are centred. */}
      <View style={styles.headerWrap}>
        <TopBar
          title="LINK YOUR HISTORY"
          subtitle={
            stats ? `${stats.totalPlays.toLocaleString()} plays stored` : 'Loading your store…'
          }
          onBack={onBack}
        />
      </View>

      <View style={styles.body}>
        <Text style={styles.lede}>
          A record only reaches your shelf once you have played every track on it, so Crates needs
          to know what you have listened to. There are three ways in, and they genuinely are not
          equivalent.
        </Text>

        {stats && stats.totalPlays > 0 ? (
          <Text style={styles.range}>
            {day(stats.firstTs)} → {day(stats.lastTs)}
          </Text>
        ) : null}

        {/* ---------------------------------------------------- Last.fm ---- */}
        <Option
          badge="PAST + FUTURE"
          badgeTone="good"
          title="Last.fm"
          claim="Your whole history, and it keeps up from here."
          limit="Only covers what you have scrobbled. If you have never used Last.fm there is nothing to import yet — you would connect Spotify to Last.fm and start from today."
        >
          {!isLastfmConfigured() ? (
            <Note text={LASTFM_SETUP_HINT} />
          ) : (
            <>
              <TextInput
                value={username}
                onChangeText={setUsername}
                placeholder="your Last.fm username"
                placeholderTextColor={theme.inkFaint}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
                editable={!busy}
              />
              <Button
                label={lastfmCursor?.last_ts ? 'Sync new scrobbles' : 'Import my history'}
                onPress={syncLastfm}
                disabled={!username.trim() || Boolean(busy) || !store}
                busy={busy?.source === 'lastfm'}
              />
              {lastfmCursor?.last_ts ? (
                <Text style={styles.meta}>Last synced up to {day(lastfmCursor.last_ts)}.</Text>
              ) : null}
            </>
          )}
        </Option>

        {/* ------------------------------------------- Spotify forward ----- */}
        <Option
          badge="FUTURE ONLY"
          badgeTone="plain"
          title="Sign in with Spotify"
          claim="Keeps your shelf filling as you listen, from today onward."
          limit="It cannot bring in anything you played before now. Spotify's API keeps only your last 50 plays and has no historical endpoint — this is a limit of Spotify, not something a future version fixes."
        >
          {!isSpotifyConfigured() ? (
            <Note text={SPOTIFY_SETUP_HINT} />
          ) : spotifyLinked ? (
            <>
              <Button
                label="Sync now"
                onPress={syncSpotify}
                disabled={Boolean(busy) || !store}
                busy={busy?.source === 'spotify_recent'}
              />
              {spotifyCursor?.last_ts ? (
                <Text style={styles.meta}>Caught up to {day(spotifyCursor.last_ts)}.</Text>
              ) : null}
              {spotifyCursor?.suspected_gaps ? (
                <Note
                  text={`${spotifyCursor.suspected_gaps} sync${
                    spotifyCursor.suspected_gaps === 1 ? '' : 's'
                  } came back full, so some plays may have aged out of Spotify's 50-track buffer before we saw them. Sync more often to avoid it.`}
                />
              ) : null}
              <Pressable onPress={unlinkSpotify} hitSlop={8}>
                <Text style={styles.unlink}>Unlink Spotify</Text>
              </Pressable>
              {!isPersistent() ? <Note text={PERSISTENCE_WARNING} /> : null}
            </>
          ) : (
            <>
              <Button
                label="Sign in with Spotify"
                onPress={auth.signIn}
                disabled={!auth.ready || auth.exchanging}
                busy={auth.exchanging}
              />
              {auth.error ? <Note text={auth.error} /> : null}
            </>
          )}
        </Option>

        {/* -------------------------------------------- Spotify export ----- */}
        <Option
          badge="PAST ONLY · MANUAL"
          badgeTone="plain"
          title="Import a Spotify data export"
          claim="The only way to get your full Spotify history."
          limit="You have to request it from Spotify yourself and wait — officially up to 30 days, usually a few days. Ask for “Extended streaming history”, not “Account data”; the latter only covers 12 months."
        >
          <Button
            label="Choose export files"
            onPress={importExport}
            disabled={Boolean(busy) || !store}
            busy={busy?.source === 'spotify_export'}
          />
          <Pressable
            onPress={() => Linking.openURL('https://www.spotify.com/account/privacy/')}
            hitSlop={8}
          >
            <Text style={styles.link}>Request your export at spotify.com →</Text>
          </Pressable>
        </Option>

        {/* ------------------------------------------------------ status --- */}
        {busy ? (
          <View style={styles.statusRow}>
            <ActivityIndicator color={theme.gold} />
            <Text style={styles.status}>{busy.message}</Text>
          </View>
        ) : null}

        {error ? <Note tone="bad" text={error} /> : null}

        {store && !store.durable && store.storageNote ? (
          <Note text={store.storageNote} />
        ) : null}

        {result ? (
          <View style={styles.card}>
            <Text style={styles.resultLine}>
              Added {result.added.toLocaleString()} new play
              {result.added === 1 ? '' : 's'}
              {result.duplicates
                ? `, skipped ${result.duplicates.toLocaleString()} already stored`
                : ''}
              .
            </Text>
            {result.skipped ? (
              <Text style={styles.meta}>
                {result.skipped.toLocaleString()} entries were podcasts or episodes, not album
                tracks.
              </Text>
            ) : null}
            {result.warnings.map((w) => (
              <Note key={w} text={w} />
            ))}
          </View>
        ) : null}

        {stats && stats.totalPlays > 0 ? (
          <View style={{ marginTop: 26 }}>
            <Text style={styles.sectionTitle}>WHERE YOUR PLAYS CAME FROM</Text>
            <View style={styles.card}>
              {(Object.entries(stats.bySource) as [SourceId, number][])
                .sort((a, b) => b[1] - a[1])
                .map(([src, n]) => (
                  <View key={src} style={styles.row}>
                    <Text style={styles.rowName}>{SOURCE_LABELS[src] ?? src}</Text>
                    <Text style={styles.rowValue}>{n.toLocaleString()}</Text>
                  </View>
                ))}
            </View>
          </View>
        ) : null}

        <Text style={styles.footnote}>
          Plays are stored on this device. Last.fm profiles are public, so reading one needs no
          password. Spotify sign-in uses PKCE and its tokens are kept in the device keychain, never
          in plain storage.
        </Text>
      </View>
    </ScrollView>
  );
}

const SOURCE_LABELS: Record<SourceId, string> = {
  lastfm: 'Last.fm',
  lastfm_csv: 'Last.fm CSV export',
  spotify_recent: 'Spotify (live)',
  spotify_export: 'Spotify export',
};

function Option({
  title,
  claim,
  limit,
  badge,
  badgeTone,
  children,
}: {
  title: string;
  claim: string;
  limit: string;
  badge?: string;
  /** 'good' is the gold recommendation; 'plain' is a neutral factual label. */
  badgeTone?: 'good' | 'plain';
  children: React.ReactNode;
}) {
  return (
    <View style={styles.option}>
      <View style={styles.optionHead}>
        <Text style={styles.optionTitle}>{title}</Text>
        {badge ? (
          <Text style={[styles.badge, badgeTone === 'plain' && styles.badgePlain]}>{badge}</Text>
        ) : null}
      </View>
      <Text style={styles.claim}>{claim}</Text>
      <Text style={styles.limit}>{limit}</Text>
      <View style={{ marginTop: 12, gap: 8 }}>{children}</View>
    </View>
  );
}

function Button({
  label,
  onPress,
  disabled,
  busy,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        (disabled || busy) && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={theme.roomDeep} />
      ) : (
        <Text style={styles.buttonText}>{label}</Text>
      )}
    </Pressable>
  );
}

function Note({ text, tone }: { text: string; tone?: 'bad' }) {
  return (
    <View style={[styles.note, tone === 'bad' && styles.noteBad]}>
      <Text style={[styles.noteText, tone === 'bad' && { color: '#ffb4a2' }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  room: { flex: 1, backgroundColor: theme.room },
  headerWrap: { maxWidth: 560, width: '100%', alignSelf: 'center' },
  body: { paddingHorizontal: 18, maxWidth: 560, width: '100%', alignSelf: 'center' },
  lede: { color: theme.inkDim, fontSize: 14, lineHeight: 21, marginTop: 6 },
  range: { color: theme.inkFaint, fontSize: 12, marginTop: 10 },

  option: {
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.cardEdge,
    borderRadius: 14,
    padding: 16,
    marginTop: 18,
  },
  optionHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  optionTitle: { color: theme.ink, fontSize: 17, fontWeight: '800' },
  badge: {
    color: theme.roomDeep,
    backgroundColor: theme.gold,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  badgePlain: {
    color: theme.inkDim,
    backgroundColor: theme.roomDeep,
    borderWidth: 1,
    borderColor: theme.cardEdge,
  },
  claim: { color: theme.ink, fontSize: 14, marginTop: 6, lineHeight: 20 },
  limit: { color: theme.inkFaint, fontSize: 12.5, marginTop: 6, lineHeight: 18 },

  input: {
    backgroundColor: theme.roomDeep,
    borderWidth: 1,
    borderColor: theme.cardEdge,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: theme.ink,
    fontSize: 15,
  },
  button: {
    backgroundColor: theme.gold,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  buttonDisabled: { backgroundColor: theme.cardEdge },
  buttonPressed: { opacity: 0.85 },
  buttonText: { color: theme.roomDeep, fontSize: 15, fontWeight: '800' },

  meta: { color: theme.inkFaint, fontSize: 12 },
  unlink: { color: theme.inkDim, fontSize: 13, textDecorationLine: 'underline', marginTop: 4 },
  link: { color: theme.gold, fontSize: 13, fontWeight: '600' },

  note: {
    backgroundColor: theme.roomDeep,
    borderLeftWidth: 3,
    borderLeftColor: theme.crate,
    borderRadius: 6,
    padding: 10,
  },
  noteBad: { borderLeftColor: '#c2553f' },
  noteText: { color: theme.inkDim, fontSize: 12.5, lineHeight: 18 },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18 },
  status: { color: theme.inkDim, fontSize: 13, flex: 1 },

  card: {
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.cardEdge,
    borderRadius: 12,
    padding: 12,
    marginTop: 18,
    gap: 8,
  },
  resultLine: { color: theme.ink, fontSize: 14, fontWeight: '600' },
  sectionTitle: {
    color: theme.gold,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 2,
    marginBottom: 8,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  rowName: { color: theme.ink, fontSize: 14, flex: 1 },
  rowValue: { color: theme.inkDim, fontSize: 13 },
  footnote: { color: theme.inkFaint, fontSize: 11.5, lineHeight: 17, marginTop: 26 },
});
