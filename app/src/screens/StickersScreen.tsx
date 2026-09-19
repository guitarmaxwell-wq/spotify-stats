/**
 * The sticker tray: everything the server has granted this user.
 *
 * Milestone 1 is display only. Placing stickers on crates is milestone 2
 * (docs/REWARDS.md section 7), so nothing here pretends otherwise.
 */

import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import AccountCard, { Button } from '../components/AccountCard';
import Sticker from '../components/Sticker';
import { earnedLine, grantedOn } from '../components/stickerText';
import TopBar from '../components/TopBar';
import { useRewards } from '../rewards';
import { theme } from '../theme';

export default function StickersScreen({
  onBack,
  onOpenLink,
}: {
  onBack: () => void;
  onOpenLink: () => void;
}) {
  const { user, rewards, loading, error, refresh, linked, stub } = useRewards();
  const { width } = useWindowDimensions();
  const content = Math.min(width, 560) - 36;
  const perRow = content > 420 ? 3 : 2;
  const tile = Math.floor((content - (perRow - 1) * 12) / perRow);

  const stickers = (rewards ?? []).filter((r) => r.kind === 'sticker');
  const verified = Boolean(linked?.verifiedAt);

  const subtitle = !user
    ? 'Earned by listening'
    : rewards === null
      ? 'Loading…'
      : stickers.length === 0
        ? 'None yet'
        : `${stickers.length} earned`;

  return (
    <ScrollView style={styles.room} contentContainerStyle={{ paddingBottom: 56 }}>
      <View style={styles.wrap}>
        <TopBar title="STICKERS" subtitle={subtitle} onBack={onBack} />
      </View>

      <View style={styles.body}>
        {stub ? (
          <Text style={styles.stub}>SAMPLE DATA · development stub, not your real account</Text>
        ) : null}

        {!user ? (
          <>
            <Text style={styles.lede}>
              Stickers are earned by listening: a hundred plays of an artist you love, say, or 182
              plays of Blink-182. Sign in and link Last.fm, and Milk checks your whole history
              against every sticker there is.
            </Text>
            <AccountCard />
          </>
        ) : rewards === null && loading ? (
          <ActivityIndicator color={theme.gold} style={{ marginTop: 40 }} />
        ) : error && rewards === null ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Couldn't load your stickers</Text>
            <Text style={styles.emptyBody}>{error}</Text>
            <Button label="Try again" onPress={refresh} busy={loading} />
          </View>
        ) : stickers.length === 0 ? (
          <View style={styles.empty}>
            <View style={styles.ghostRow}>
              {[0, 1, 2].map((i) => (
                <View key={i} style={[styles.ghostDisc, { transform: [{ rotate: `${(i - 1) * 8}deg` }] }]} />
              ))}
            </View>
            <Text style={styles.emptyTitle}>Your tray is waiting</Text>
            {verified ? (
              <Text style={styles.emptyBody}>
                Your Last.fm is linked, so every sync checks your plays against every sticker.
                Keep listening. The first one might be closer than you think.
              </Text>
            ) : (
              <>
                <Text style={styles.emptyBody}>
                  Stickers come from your real listening history. Link your Last.fm and Milk will
                  go through all of it. Years of scrobbles can earn a few straight away.
                </Text>
                <Button label="Link Last.fm" onPress={onOpenLink} />
              </>
            )}
          </View>
        ) : (
          <>
            <View style={styles.grid}>
              {stickers.map((r) => (
                <View key={r.key} style={[styles.tile, { width: tile }]}>
                  <Sticker rewardId={r.rewardId} name={r.name} artUrl={r.artUrl} size={Math.min(tile - 24, 120)} />
                  <Text style={styles.name} numberOfLines={2}>
                    {r.name}
                  </Text>
                  {r.subjectName ? (
                    <Text style={styles.subject} numberOfLines={1}>
                      {r.subjectName}
                    </Text>
                  ) : null}
                  <Text style={styles.why} numberOfLines={2}>
                    {earnedLine(r)}
                  </Text>
                  <Text style={styles.date}>{grantedOn(r)}</Text>
                </View>
              ))}
            </View>
            {!verified ? (
              <Pressable onPress={onOpenLink} hitSlop={8}>
                <Text style={styles.link}>Link Last.fm to keep earning →</Text>
              </Pressable>
            ) : null}
            <Text style={styles.note}>
              Soon you'll be able to stick these on your crates.
            </Text>
            {error ? <Text style={styles.bad}>{error}</Text> : null}
          </>
        )}

        {user ? (
          <View style={{ marginTop: 30 }}>
            <AccountCard />
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  room: { flex: 1, backgroundColor: theme.room },
  wrap: { maxWidth: 560, width: '100%', alignSelf: 'center' },
  body: { paddingHorizontal: 18, maxWidth: 560, width: '100%', alignSelf: 'center', gap: 16 },
  lede: { color: theme.inkDim, fontSize: 14, lineHeight: 21, marginTop: 6 },
  stub: {
    color: theme.roomDeep,
    backgroundColor: theme.gold,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    alignSelf: 'flex-start',
    overflow: 'hidden',
  },
  empty: {
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.cardEdge,
    borderRadius: 14,
    padding: 20,
    gap: 12,
    marginTop: 8,
  },
  ghostRow: { flexDirection: 'row', justifyContent: 'center', gap: 10, marginBottom: 4 },
  ghostDisc: {
    width: 58,
    height: 58,
    borderRadius: 29,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: theme.cardEdge,
    backgroundColor: theme.roomDeep,
  },
  emptyTitle: { color: theme.ink, fontSize: 18, fontWeight: '800', textAlign: 'center' },
  emptyBody: { color: theme.inkDim, fontSize: 13.5, lineHeight: 20, textAlign: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 8 },
  tile: {
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.cardEdge,
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 10,
    alignItems: 'center',
  },
  name: { color: theme.ink, fontSize: 14, fontWeight: '800', textAlign: 'center', marginTop: 12 },
  subject: {
    color: theme.gold,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    marginTop: 3,
    textAlign: 'center',
  },
  why: { color: theme.inkDim, fontSize: 12, textAlign: 'center', marginTop: 4, lineHeight: 16 },
  date: { color: theme.inkFaint, fontSize: 11, marginTop: 4 },
  link: { color: theme.gold, fontSize: 13, fontWeight: '700' },
  note: { color: theme.inkFaint, fontSize: 12, textAlign: 'center' },
  bad: { color: '#ffb4a2', fontSize: 12.5 },
});
