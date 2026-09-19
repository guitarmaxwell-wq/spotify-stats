/**
 * Sign in to Milk, by email: a link plus a 6-digit code, no password.
 *
 * Email is chosen deliberately. Offering a third-party login (Google, Spotify
 * as identity) would make Sign in with Apple mandatory under App Store
 * Guideline 4.8; an email link or code does not. The code is there because a
 * link only works on the device that asked for it, and people read email on
 * their laptops.
 *
 * Signing in is never a gate. This card explains what it adds and nothing
 * else in the app waits on it.
 */

import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { rewardsApi, sessionPersists, useRewards } from '../rewards';
import { theme } from '../theme';

export default function AccountCard({ pitch }: { pitch?: string }) {
  const { configured, user, ready, stub, linkError } = useRewards();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!configured) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>Milk account</Text>
        <Text style={styles.body}>
          Accounts aren't set up in this build, so stickers are unavailable. Everything else on
          the shelf works as normal.
        </Text>
      </View>
    );
  }

  if (!ready) {
    return (
      <View style={[styles.card, { alignItems: 'center' }]}>
        <ActivityIndicator color={theme.gold} />
      </View>
    );
  }

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (user) {
    return (
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.kicker}>SIGNED IN</Text>
            <Text style={styles.who} numberOfLines={1}>
              {user.email ?? 'Milk account'}
            </Text>
          </View>
          <Pressable onPress={() => act(() => rewardsApi.signOut())} hitSlop={8} disabled={busy}>
            <Text style={styles.textButton}>Sign out</Text>
          </Pressable>
        </View>
        {!sessionPersists() && !stub ? (
          <Text style={styles.fine}>
            On web you stay signed in for this tab only. Your sign-in is never written to browser
            storage.
          </Text>
        ) : null}
        {error ? <Text style={styles.bad}>{error}</Text> : null}
      </View>
    );
  }

  const cleanEmail = email.trim();
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail);

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Sign in to earn stickers</Text>
      <Text style={styles.body}>
        {pitch ??
          'A free Milk account lets us verify your Last.fm and award stickers for what you actually listen to. The shelf keeps working without one.'}
      </Text>

      {sentTo === null ? (
        <>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={theme.inkFaint}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            keyboardType="email-address"
            inputMode="email"
            style={styles.input}
            editable={!busy}
          />
          <Button
            label="Email me a sign-in code"
            disabled={!emailOk}
            busy={busy}
            onPress={() =>
              act(async () => {
                await rewardsApi.sendEmailSignIn(cleanEmail);
                setSentTo(cleanEmail);
              })
            }
          />
          <Text style={styles.fine}>No password. We only use your email to sign you in.</Text>
        </>
      ) : (
        <>
          <Text style={styles.body}>
            We sent a message to <Text style={styles.strong}>{sentTo}</Text>. Tap the link in it on
            this phone, or type the 6-digit code here.
          </Text>
          <TextInput
            value={code}
            onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
            placeholder="6-digit code"
            placeholderTextColor={theme.inkFaint}
            keyboardType="number-pad"
            inputMode="numeric"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            maxLength={6}
            style={[styles.input, styles.code]}
            editable={!busy}
          />
          <Button
            label="Sign in"
            disabled={code.length !== 6}
            busy={busy}
            onPress={() => act(() => rewardsApi.verifyEmailCode(sentTo, code))}
          />
          <Pressable
            onPress={() => {
              setSentTo(null);
              setCode('');
              setError(null);
            }}
            hitSlop={8}
          >
            <Text style={styles.textButton}>Use a different email</Text>
          </Pressable>
        </>
      )}
      {error || linkError ? <Text style={styles.bad}>{error ?? linkError}</Text> : null}
    </View>
  );
}

export function Button({
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
        <Text style={[styles.buttonText, disabled && { color: theme.inkFaint }]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.cardEdge,
    borderRadius: 14,
    padding: 16,
    gap: 10,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  kicker: { color: theme.gold, fontSize: 10, fontWeight: '900', letterSpacing: 1.6 },
  who: { color: theme.ink, fontSize: 15, fontWeight: '700', marginTop: 2 },
  title: { color: theme.ink, fontSize: 17, fontWeight: '800' },
  body: { color: theme.inkDim, fontSize: 13.5, lineHeight: 20 },
  strong: { color: theme.ink, fontWeight: '700' },
  fine: { color: theme.inkFaint, fontSize: 12, lineHeight: 17 },
  bad: { color: '#ffb4a2', fontSize: 12.5, lineHeight: 18 },
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
  code: { fontSize: 22, letterSpacing: 8, textAlign: 'center', fontWeight: '700' },
  textButton: { color: theme.inkDim, fontSize: 13, textDecorationLine: 'underline' },
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
});
