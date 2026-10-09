// Settings, as the extension's sheet: profile, account reset, display preferences, server status
// and account removal. The overlay-only switches (paper panel on FOMO, discreet mode) don't apply
// to a standalone app and are gone with them.

import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';

import { GoogleIcon, Icon } from '@/components/icons';
import { CapitalPicker, capitalAmount, capitalError, createCapitalChoice, type CapitalChoice } from '@/components/capital-picker';
import { Banner, Btn, Card, Field, Input, SegTabs } from '@/components/ui';
import { Palette } from '@/constants/paper';
import { ApiError, api } from '@/lib/api';
import { formatUsd } from '@/lib/format';
import { NAME_MAX, nameError, suggestedName } from '@/lib/profile';
import { setSession } from '@/lib/storage';
import type { SessionUser } from '@/lib/types';
import { useApp } from '@/state/app';
import { Image } from 'expo-image';

function Row({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowLead}>
        <Text style={styles.rowTitle}>{title}</Text>
        {subtitle ? <Text style={styles.rowSub}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  );
}

export default function SettingsScreen() {
  const {
    user,
    config,
    serverError,
    settings,
    account,
    busy,
    setBusy,
    flash,
    banner,
    updateSettings,
    signInWithGoogle,
    signOut,
    loadAccount,
    loadPortfolio,
  } = useApp();

  const [name, setName] = useState(() => suggestedName(user));
  const [nameProblem, setNameProblem] = useState<string | null>(null);
  const [profileSaved, setProfileSaved] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [choice, setChoice] = useState<CapitalChoice>(() => createCapitalChoice(config, account?.startingBalance ?? null));
  const [resetProblem, setResetProblem] = useState<string | null>(null);
  const [armedDelete, setArmedDelete] = useState(false);

  const saveProfile = async (patch: { displayName?: string; photoUrl?: string | null }, done: string) => {
    if (patch.displayName !== undefined) {
      const invalid = nameError(patch.displayName);
      if (invalid) {
        setNameProblem(invalid);
        return;
      }
      setNameProblem(null);
    }
    try {
      await api.updateProfile(patch);
      setProfileSaved(done);
      flash('ok', done);
    } catch (err) {
      flash('err', err instanceof ApiError ? err.message : 'Could not save your profile.');
    }
  };

  const pickPhoto = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      flash('err', 'Photo access is needed to set a profile picture.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
      base64: true,
    });
    const asset = result.canceled ? null : result.assets[0];
    if (!asset?.base64) return;
    await saveProfile(
      { photoUrl: `data:image/jpeg;base64,${asset.base64}` },
      'Picture saved.',
    );
  };

  const doReset = async () => {
    const invalid = capitalError(choice, config);
    if (invalid) return setResetProblem(invalid);
    setResetProblem(null);
    setBusy(true);
    try {
      const res = await api.resetAccount(capitalAmount(choice));
      await loadAccount();
      await loadPortfolio();
      setResetOpen(false);
      flash('ok', `New paper account started with ${formatUsd(res.account.startingBalance)}.`);
    } catch (err) {
      setResetProblem(err instanceof ApiError ? err.message : 'Could not reset the account.');
    } finally {
      setBusy(false);
    }
  };

  const deleteAccount = async () => {
    if (!armedDelete) {
      setArmedDelete(true);
      return;
    }
    setBusy(true);
    try {
      await api.deleteAccount();
      flash('ok', 'Account and history deleted.');
      router.replace('/');
    } catch (err) {
      flash('err', err instanceof ApiError ? err.message : 'Could not delete the account.');
    } finally {
      setBusy(false);
      setArmedDelete(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Text style={styles.title}>Settings</Text>
        <View style={{ flex: 1 }} />
        <Pressable accessibilityRole="button" accessibilityLabel="Close settings" onPress={() => router.back()} hitSlop={10} style={styles.close}>
          <Icon name="close" size={18} color={Palette.textSecondary} />
        </Pressable>
      </View>

      {/* Fixed above the scroller: the cards that flash (session restore, danger zone) sit at the
          bottom, so a banner rendered inside the content would be scrolled out of sight. */}
      {banner ? (
        <View style={styles.bannerWrap}>
          <Banner kind={banner.kind}>{banner.text}</Banner>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {user ? (
          <Card style={{ padding: 14, gap: 12 }}>
            <Text style={styles.groupTitle}>Profile</Text>
            <Text style={styles.signedIn}>Signed in as {user.email}</Text>

            <View style={styles.photoRow}>
              <View style={styles.avatar}>
                {user.photoUrl ? (
                  <Image source={{ uri: user.photoUrl }} style={styles.avatarImage} contentFit="cover" />
                ) : (
                  <Text style={styles.avatarLetter}>{(user.displayName || user.email || '?').slice(0, 1).toUpperCase()}</Text>
                )}
              </View>
              <View style={{ flex: 1, gap: 6 }}>
                <View style={styles.photoActions}>
                  <Btn label={user.photoUrl ? 'Change picture' : 'Add picture'} variant="sm" icon="image" onPress={() => void pickPhoto()} />
                  {user.photoUrl ? (
                    <Btn label="Remove" variant="sm" onPress={() => void saveProfile({ photoUrl: null }, 'Picture removed.')} />
                  ) : null}
                </View>
              </View>
            </View>

            <Field label="Username" error={nameProblem}>
              <Input
                value={name}
                onChangeText={(v) => {
                  setName(v);
                  setNameProblem(nameError(v));
                }}
                maxLength={NAME_MAX}
                placeholder="How you show up on shared P&L cards."
              />
            </Field>
            <Btn label="Save profile" variant="sm" onPress={() => void saveProfile({ displayName: name.trim() }, 'Username saved.')} />
            {profileSaved ? <Text style={styles.saved}>{profileSaved}</Text> : null}
          </Card>
        ) : (
          <Card style={{ padding: 14, gap: 10 }}>
            <Text style={styles.groupTitle}>Account</Text>
            <Text style={styles.signedIn}>You&apos;re browsing without an account. Prices work either way.</Text>
            <Btn
              label="Continue with Google"
              variant="setup"
              left={<GoogleIcon size={17} />}
              busy={busy}
              onPress={() => void signInWithGoogle()}
            />
          </Card>
        )}

        <Card style={{ padding: 14, gap: 12 }}>
          <Text style={styles.groupTitle}>Account</Text>
          {user && account ? (
            <Row
              title="Reset paper account"
              subtitle={`Start over with new capital. Now ${formatUsd(account.startingBalance, { decimals: 0 })}.`}
              right={<Btn label="Reset" variant="sm" onPress={() => setResetOpen((v) => !v)} />}
            />
          ) : null}

          {resetOpen ? (
            <CapitalPicker
              config={config}
              choice={choice}
              onChange={setChoice}
              busy={busy}
              onSubmit={() => void doReset()}
              submitLabel="Reset account"
              error={resetProblem}
            />
          ) : null}

          <Row
            title="Hide dust"
            subtitle="Keep positions under $3 out of the portfolio list."
            right={
              <Switch
                value={settings.hideDust}
                onValueChange={(v) => void updateSettings({ hideDust: v })}
                trackColor={{ false: Palette.lineStrong, true: Palette.paperStrong }}
                thumbColor={Palette.textPrimary}
              />
            }
          />
          <Row
            title="Show entry and exit as"
            subtitle="Price per token, or market cap."
            right={
              <SegTabs
                value={settings.priceDisplay}
                onChange={(v) => void updateSettings({ priceDisplay: v })}
                options={[
                  { value: 'price', label: '$' },
                  { value: 'mcap', label: 'MC' },
                ]}
              />
            }
          />
        </Card>

        <Card style={{ padding: 14, gap: 10 }}>
          <Text style={styles.groupTitle}>Paper server</Text>
          <View style={styles.status}>
            <View style={[styles.dot, { backgroundColor: serverError ? Palette.red : Palette.green }]} />
            <Text style={styles.statusText}>
              {serverError ? (
                <>
                  <Text style={{ fontWeight: '800' }}>Offline.</Text> {serverError.message}
                </>
              ) : (
                <>Connected, market data from {config?.marketDataProvider || 'the server'}</>
              )}
            </Text>
          </View>
          <Text style={styles.serverUrl}>{String(settings.serverUrl).replace(/^https?:\/\//, '')}</Text>
          <Text style={styles.fine}>Trades here are simulated. No wallet is connected and no real order is sent.</Text>
        </Card>

        {user ? (
          <Card style={{ padding: 14, gap: 10 }}>
            <Text style={styles.groupTitle}>Danger zone</Text>
            <Row
              title="Delete account and data"
              subtitle="Removes your profile, trades and history from the server. This cannot be undone."
              right={
                <Btn
                  label={armedDelete ? 'Tap again' : 'Delete'}
                  variant="danger"
                  busy={busy}
                  onPress={() => void deleteAccount()}
                />
              }
            />
            <Btn label="Sign out" variant="sm" icon="signout" busy={busy} onPress={() => void signOut()} />
          </Card>
        ) : null}

        {!user ? <ExtensionSessionCard /> : null}

        <Btn label="Done" variant="setup" onPress={() => router.back()} style={{ alignSelf: 'stretch' }} />
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Sign-in escape hatch. Google sign-in is blocked for this app (the paper server validates the
 * token's `aud` against the extension's own client id), so the session is instead lifted from the
 * extension's `chrome.storage.local` and pasted here. The token is a bearer token — the server
 * only checks that it is valid, not which client produced it — so an extension session works
 * identically in the app. It carries no refresh token, so when it expires this has to be redone.
 */
function ExtensionSessionCard() {
  const { flash } = useApp();
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  // Kept local as well as in the global banner: this card sits at the very bottom of Settings, so
  // the outcome has to be readable without scrolling back up to find it.
  const [problem, setProblem] = useState<string | null>(null);

  const restore = async () => {
    // DevTools echoes a string containing `"` wrapped in single quotes, so a copy straight out of
    // the console arrives as `'{"session":…}'`. Those quotes are display, not data: without
    // stripping them JSON.parse throws and the paste is sent verbatim as a bearer token.
    const unquote = (s: string) => {
      const m = /^(['"])([\s\S]*)\1$/.exec(s);
      return m ? m[2].trim() : s;
    };

    const value = unquote(raw.trim());
    if (!value) {
      setProblem('Paste the session from the extension first.');
      return;
    }
    setProblem(null);

    // The extension stores `{ token, user }` under the `session` key, so `chrome.storage.local`
    // hands back `{ session: { token, user } }`. Accept that wrapper, the bare object, or a raw token.
    let token = value;
    let user: SessionUser | undefined;
    try {
      const parsed = JSON.parse(value) as
        | { session?: { token?: string; user?: SessionUser }; token?: string; user?: SessionUser }
        | undefined;
      const inner = parsed?.session ?? parsed;
      if (inner?.token) {
        token = inner.token;
        user = inner.user;
      } else {
        setProblem('That JSON has no session.token in it — copy it again from the extension.');
        return;
      }
    } catch {
      // not JSON — treat the whole paste as the token
    }

    setBusy(true);
    try {
      // Verify against the server before writing anything, so a stale token never lands in storage.
      const me = await api.verifyToken(token);
      // Prefer the user the server returns: it is the live record, and covers a bare-token paste.
      const who = me.user ?? user ?? {};
      await setSession({ token, user: who });
      flash('ok', `Signed in${who.email ? ` as ${who.email}` : ''}.`);
      setRaw('');
    } catch (err) {
      const message = err instanceof ApiError ? err.message : `That session was rejected (${err instanceof Error ? err.message : String(err)}).`;
      setProblem(message);
      flash('err', message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ padding: 14, gap: 10 }}>
      <Text style={styles.groupTitle}>Extension session</Text>
      <Text style={styles.rowSub}>
        Paste the session the Chrome extension already holds. Google sign-in is blocked for this app, so this is the way
        in for now. The token is not refreshed — when it expires, paste a new one.
      </Text>
      <Field label="Session JSON">
        <Input
          value={raw}
          onChangeText={setRaw}
          placeholder='{"session":{"token":"…","user":{…}}}'
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          style={{ minHeight: 68, textAlignVertical: 'top' }}
        />
      </Field>
      <Btn label="Restore session" variant="sm" busy={busy} onPress={() => void restore()} />
      {problem ? <Banner kind="err">{problem}</Banner> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Palette.bgPrimary },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  title: { fontSize: 22, fontWeight: '800', color: Palette.textPrimary },
  close: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: Palette.bgSecondary },

  body: { padding: 14, gap: 10, paddingBottom: 40 },
  bannerWrap: { paddingHorizontal: 14, paddingBottom: 4 },
  groupTitle: { fontSize: 12, fontWeight: '800', color: Palette.textTertiary, textTransform: 'uppercase', letterSpacing: 1 },
  signedIn: { fontSize: 13, color: Palette.textSecondary },
  saved: { fontSize: 12, color: Palette.green },

  photoRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Palette.bgTertiarySolid,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Palette.line,
  },
  avatarLetter: { fontSize: 22, fontWeight: '800', color: Palette.textSecondary },
  avatarImage: { width: '100%', height: '100%', borderRadius: 28 },
  photoActions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },

  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowLead: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 14, fontWeight: '700', color: Palette.textPrimary },
  rowSub: { fontSize: 12, color: Palette.textSecondary, lineHeight: 17 },

  status: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { flex: 1, fontSize: 13, color: Palette.textSecondary, lineHeight: 18 },
  serverUrl: { fontSize: 12, color: Palette.textTertiary, fontVariant: ['tabular-nums'] },
  fine: { fontSize: 11, color: Palette.textTertiary, lineHeight: 16 },
});
