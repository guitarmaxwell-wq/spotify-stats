/**
 * The verified Last.fm link: the only path whose plays count toward rewards.
 *
 * A username alone proves nothing (profiles are public; anyone can type
 * anyone's name), so this goes through Last.fm's own approval page via the
 * `lastfm-auth-start` Edge Function, which binds the approval to this Milk user
 * (docs/REWARDS.md sections 2 and 9). After that the server fetches the plays
 * itself; this app never uploads a play count.
 */

import React, { useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';

import AccountCard, { Button } from './AccountCard';
import { reasonText, rewardsApi, useRewards } from '../rewards';
import { theme } from '../theme';

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : null;

export default function LastfmVerifiedLink() {
  const { configured, user, linked, refresh, sync, syncing, syncError, startSync, loading } = useRewards();
  const [linking, setLinking] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad' | 'plain'; text: string } | null>(null);

  if (!configured) return null;

  if (!user) {
    return (
      <AccountCard pitch="Sign in to link Last.fm properly. Last.fm confirms the account is yours, and your plays can then earn stickers." />
    );
  }

  const verified = Boolean(linked?.verifiedAt);

  const connect = async () => {
    setLinking(true);
    setNotice(null);
    try {
      const outcome = await rewardsApi.linkLastfm();
      if (outcome.status === 'ok') {
        setNotice({ tone: 'good', text: 'Last.fm confirmed it is your account. Bringing in your history now.' });
        await refresh();
        startSync();
      } else if (outcome.status === 'error') {
        setNotice({ tone: 'bad', text: reasonText(outcome.reason) });
      } else {
        setNotice({
          tone: 'plain',
          text:
            Platform.OS === 'web'
              ? "The Last.fm page closed without sending you back. A browser can't return to the Milk app, so finish linking on your phone."
              : 'Linking was cancelled. Nothing changed. Tap Connect Last.fm whenever you are ready.',
        });
      }
    } catch (e) {
      setNotice({ tone: 'bad', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setLinking(false);
    }
  };

  return (
    <View style={styles.wrap}>
      {verified ? (
        <>
          <View style={styles.row}>
            <Text style={styles.check}>✓</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.kicker}>VERIFIED BY LAST.FM</Text>
              <Text style={styles.who}>{linked!.username}</Text>
            </View>
          </View>
          <Text style={styles.meta}>
            {linked!.lastSyncedAt
              ? `Last synced ${when(linked!.lastSyncedAt)}.`
              : 'Not synced yet.'}{' '}
            These plays count toward stickers.
          </Text>
          <Button
            label={linked!.lastSyncedAt ? 'Sync now' : 'Bring in my history'}
            onPress={startSync}
            busy={syncing}
          />
        </>
      ) : (
        <>
          <Text style={styles.body}>
            You'll approve Milk on Last.fm's own page, then come straight back here.
          </Text>
          <Button label="Connect Last.fm" onPress={connect} busy={linking} disabled={loading} />
        </>
      )}

      {sync && (syncing || sync.done || sync.calls > 0) ? (
        <View style={styles.progress}>
          {syncing ? (
            <ActivityIndicator color={theme.gold} />
          ) : (
            <Text style={styles.check}>{sync.done ? '✓' : '‖'}</Text>
          )}
          <View style={{ flex: 1 }}>
            <Text style={styles.progressLine}>
              {syncing
                ? sync.waiting
                  ? 'Waiting for another sync to finish…'
                  : sync.calls === 0
                  ? 'Starting sync…'
                  : `Syncing… ${sync.pages.toLocaleString()} page${sync.pages === 1 ? '' : 's'} read`
                : sync.done
                  ? 'Up to date'
                  : `Paused after ${sync.pages.toLocaleString()} page${sync.pages === 1 ? '' : 's'}`}
            </Text>
            <Text style={styles.meta}>
              {sync.playsAdded.toLocaleString()} new play{sync.playsAdded === 1 ? '' : 's'}
              {sync.granted > 0
                ? ` · ${sync.granted} new sticker${sync.granted === 1 ? '' : 's'}!`
                : ''}
              {syncing && sync.calls > 0 ? ' · a first sync of years of history can take a few minutes' : ''}
            </Text>
          </View>
        </View>
      ) : null}

      {syncError ? (
        <Text style={styles.bad}>
          {syncError} Your progress is saved. Tap Sync to continue.
        </Text>
      ) : null}

      {notice ? (
        <Text style={notice.tone === 'bad' ? styles.bad : notice.tone === 'good' ? styles.good : styles.meta}>
          {notice.text}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  check: { color: theme.gold, fontSize: 20, fontWeight: '900', width: 22, textAlign: 'center' },
  kicker: { color: theme.gold, fontSize: 10, fontWeight: '900', letterSpacing: 1.6 },
  who: { color: theme.ink, fontSize: 16, fontWeight: '800', marginTop: 1 },
  body: { color: theme.inkDim, fontSize: 13, lineHeight: 19 },
  meta: { color: theme.inkFaint, fontSize: 12, lineHeight: 17 },
  good: { color: '#a8d8b0', fontSize: 12.5, lineHeight: 18 },
  bad: { color: '#ffb4a2', fontSize: 12.5, lineHeight: 18 },
  progress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: theme.roomDeep,
    borderRadius: 10,
    padding: 10,
  },
  progressLine: { color: theme.ink, fontSize: 13.5, fontWeight: '700' },
});
