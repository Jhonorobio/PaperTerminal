// The extension's side panel opened to welcome → consent → setup → trade. This screen is that
// gate: whichever state the session is in decides what the root route shows, and once the user is
// ready it hands off to the tabs. Browsing without an account is allowed — quotes are public.

import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Redirect, router } from 'expo-router';

import { CapitalPicker, capitalAmount, capitalError, createCapitalChoice, type CapitalChoice } from '@/components/capital-picker';
import { GoogleIcon, Icon } from '@/components/icons';
import { Banner, Btn, Field, Input } from '@/components/ui';
import { Palette, Radius } from '@/constants/paper';
import { authInfo, ApiError, api } from '@/lib/api';
import { consentError, NAME_MAX, nameError, suggestedName } from '@/lib/profile';
import { formatUsd } from '@/lib/format';
import { useApp } from '@/state/app';

function Check({ checked, onToggle, children }: { checked: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <Pressable onPress={onToggle} style={styles.checkRow} accessibilityRole="checkbox" accessibilityState={{ checked }}>
      <View style={[styles.box, checked && styles.boxOn]}>
        {checked ? <Icon name="check" size={13} color={Palette.bgPrimary} /> : null}
      </View>
      <Text style={styles.checkText}>{children}</Text>
    </Pressable>
  );
}

function ConsentFields({
  age,
  terms,
  onAge,
  onTerms,
  minimumAge,
  error,
}: {
  age: boolean;
  terms: boolean;
  onAge: (v: boolean) => void;
  onTerms: (v: boolean) => void;
  minimumAge: number;
  error?: string | null;
}) {
  return (
    <View style={styles.consent}>
      <Check checked={age} onToggle={() => onAge(!age)}>
        I am {minimumAge} or older.
      </Check>
      <Check checked={terms} onToggle={() => onTerms(!terms)}>
        I accept the Terms and Privacy Policy, and I understand every trade here is simulated.
      </Check>
      {error ? <Text style={styles.errText}>{error}</Text> : null}
    </View>
  );
}

export default function Gate() {
  const { ready, user, needsSetup, needsConsent, settings } = useApp();

  if (!ready) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.center}>
          <Icon name="paper" size={40} color={Palette.paper} />
          <Text style={styles.loading}>Paper Terminal</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (user && needsConsent && !needsSetup) return <ConsentGate />;
  if (user && needsSetup) return <Setup />;
  if (!user && !settings.guestOk) return <Welcome />;

  return <Redirect href="/trade" />;
}

function Welcome() {
  const { config, serverError, busy, signInWithGoogle, signInDev, loadConfig, updateSettings, flash } = useApp();
  const [devEmail, setDevEmail] = useState('');
  const [devName, setDevName] = useState('');
  const minimumAge = config?.minimumAge ?? 18;
  const googleReady = authInfo.googleConfigured();

  const enter = async () => {
    await updateSettings({ guestOk: true });
    router.replace('/trade');
  };

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.pane}>
        <View style={styles.heroMark}>
          <Icon name="paper" size={34} color={Palette.paper} />
        </View>
        <Text style={styles.h1}>Practice on FOMO with paper money</Text>
        <Text style={styles.sub}>Same trading flow, virtual balance, a full record of every trade.</Text>

        <View style={styles.steps}>
          {[
            ['1', 'Sign in', 'with Google'],
            ['2', 'Choose', 'your starting capital'],
            ['3', 'Trade', 'any token'],
          ].map(([n, strong, rest]) => (
            <View key={n} style={styles.step}>
              <View style={styles.stepNum}>
                <Text style={styles.stepNumText}>{n}</Text>
              </View>
              <Text style={styles.stepText}>
                <Text style={{ fontWeight: '800', color: Palette.textPrimary }}>{strong}</Text> {rest}
              </Text>
            </View>
          ))}
        </View>

        {serverError ? (
          <Banner kind="err">
            {serverError.message} <Text style={styles.retry} onPress={() => void loadConfig()}>Retry</Text>
          </Banner>
        ) : null}

        {!googleReady && !config?.devAuth ? (
          <Banner kind="err">
            Google sign-in isn&apos;t configured yet. Set EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID in .env — everything except signing in
            still works.
          </Banner>
        ) : null}

        <Btn
          label="Continue with Google"
          variant="setup"
          left={<GoogleIcon size={18} />}
          busy={busy}
          disabled={!!serverError || !googleReady}
          onPress={() => void signInWithGoogle()}
          style={{ alignSelf: 'stretch' }}
        />

        <Btn label="Browse without an account" variant="ghost" onPress={() => void enter()} style={{ alignSelf: 'stretch' }} />

        <Text style={styles.fine}>
          Your paper account is separate from FOMO. We never ask for your FOMO login, wallet or keys.
        </Text>
        <Text style={styles.fine}>
          For {minimumAge}s and over. By continuing you accept the Terms and the Privacy policy.
        </Text>

        {config?.devAuth ? (
          <View style={styles.devBox}>
            <Text style={styles.divider}>local developer sign-in</Text>
            <Field label="Email">
              <Input
                value={devEmail}
                onChangeText={setDevEmail}
                placeholder="you@example.com"
                autoCapitalize="none"
                keyboardType="email-address"
              />
            </Field>
            <Field label="Display name">
              <Input value={devName} onChangeText={setDevName} placeholder="Your name" />
            </Field>
            <Btn
              label="Sign in"
              variant="sm"
              busy={busy}
              onPress={() => {
                if (!devEmail.trim()) return flash('err', 'Enter an email.');
                void signInDev(devEmail.trim(), devName.trim() || undefined);
              }}
            />
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function ConsentGate() {
  const { config, busy, loadAccount, flash } = useApp();
  const minimumAge = config?.minimumAge ?? 18;
  const [age, setAge] = useState(false);
  const [terms, setTerms] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    const invalid = consentError(age, terms, minimumAge);
    if (invalid) return setError(invalid);
    setError(null);
    try {
      await api.consent({ acceptedTerms: true, confirmedAge: true });
      await loadAccount();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save your confirmation.');
      flash('err', err instanceof ApiError ? err.message : 'Could not save your confirmation.');
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.pane}>
        <Text style={styles.h1}>A quick confirmation before you trade</Text>
        <Text style={styles.sub}>Our terms changed. Confirm these two and you are back where you were. Your history is untouched.</Text>
        <ConsentFields age={age} terms={terms} onAge={setAge} onTerms={setTerms} minimumAge={minimumAge} error={error} />
        <Btn label="Agree and Continue" variant="setup" busy={busy} onPress={() => void accept()} style={{ alignSelf: 'stretch' }} />
        <Text style={styles.fine}>Paper Terminal simulates trades. No wallet, no real orders, no real funds.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Setup() {
  const { user, config, serverError, busy, flash, loadAccount, updateSettings } = useApp();
  const minimumAge = config?.minimumAge ?? 18;
  const [name, setName] = useState(() => suggestedName(user));
  const [nameProblem, setNameProblem] = useState<string | null>(null);
  const [age, setAge] = useState(false);
  const [terms, setTerms] = useState(false);
  const [consentProblem, setConsentProblem] = useState<string | null>(null);
  const [choice, setChoice] = useState<CapitalChoice>(() => createCapitalChoice(config));
  const [capitalProblem, setCapitalProblem] = useState<string | null>(null);

  const start = async () => {
    const invalidName = nameError(name);
    if (invalidName) return setNameProblem(invalidName);
    setNameProblem(null);
    const invalidConsent = consentError(age, terms, minimumAge);
    if (invalidConsent) return setConsentProblem(invalidConsent);
    setConsentProblem(null);
    const invalidCapital = capitalError(choice, config);
    if (invalidCapital) return setCapitalProblem(invalidCapital);
    setCapitalProblem(null);

    try {
      await api.consent({ acceptedTerms: true, confirmedAge: true });
      await api.updateProfile({ displayName: name.trim() });
      const res = await api.startAccount(capitalAmount(choice));
      await loadAccount();
      await updateSettings({ guestOk: true });
      flash('ok', `You're set with ${formatUsd(res.account.startingBalance)} in virtual cash.`);
      router.replace('/trade');
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Could not start your account.';
      setCapitalProblem(message);
      flash('err', message);
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.pane}>
        <View style={styles.signedIn}>
          <Icon name="check" size={14} color={Palette.green} />
          <Text style={styles.signedInText}>
            Signed in as <Text style={{ fontWeight: '800', color: Palette.textPrimary }}>{user?.email}</Text>
          </Text>
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

        <Text style={styles.h2}>How much do you want to practice with?</Text>
        <Text style={styles.sub}>Pick a size close to what you would really trade.</Text>

        {serverError ? <Banner kind="err">{serverError.message}</Banner> : null}

        <ConsentFields age={age} terms={terms} onAge={setAge} onTerms={setTerms} minimumAge={minimumAge} error={consentProblem} />

        <CapitalPicker
          config={config}
          choice={choice}
          onChange={setChoice}
          busy={busy}
          onSubmit={() => void start()}
          submitLabel="OK, start trading"
          error={capitalProblem}
        />

        <Text style={styles.fine}>You can pick a new amount later with Reset in Settings.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Palette.bgPrimary },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loading: { color: Palette.paper, fontWeight: '800', fontSize: 16, letterSpacing: 1 },
  pane: { padding: 20, gap: 14, paddingBottom: 40 },

  heroMark: {
    width: 64,
    height: 64,
    borderRadius: 20,
    backgroundColor: Palette.paperT,
    borderWidth: 1,
    borderColor: Palette.paperLine,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginTop: 12,
  },
  h1: { fontSize: 24, fontWeight: '800', color: Palette.textPrimary, textAlign: 'center' },
  h2: { fontSize: 20, fontWeight: '800', color: Palette.textPrimary },
  sub: { fontSize: 14, color: Palette.textSecondary, lineHeight: 20, textAlign: 'center' },
  fine: { fontSize: 12, color: Palette.textTertiary, textAlign: 'center', lineHeight: 17 },

  steps: { gap: 8, alignSelf: 'stretch' },
  step: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepNum: { width: 26, height: 26, borderRadius: 13, backgroundColor: Palette.paperT, alignItems: 'center', justifyContent: 'center' },
  stepNumText: { fontSize: 12, fontWeight: '800', color: Palette.paper, fontVariant: ['tabular-nums'] },
  stepText: { fontSize: 14, color: Palette.textSecondary },

  retry: { color: Palette.paper, fontWeight: '800', textDecorationLine: 'underline' },

  devBox: { gap: 8, alignSelf: 'stretch', paddingTop: 8, borderTopWidth: 1, borderTopColor: Palette.line },
  divider: { fontSize: 11, color: Palette.textTertiary, textTransform: 'uppercase', letterSpacing: 1, textAlign: 'center' },

  consent: { gap: 8, alignSelf: 'stretch', backgroundColor: Palette.bgSecondary, borderRadius: Radius.md, borderWidth: 1, borderColor: Palette.line, padding: 12 },
  checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  box: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: Palette.lineStrong,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Palette.bgPrimary,
    marginTop: 1,
  },
  boxOn: { backgroundColor: Palette.paper, borderColor: Palette.paper },
  checkText: { flex: 1, fontSize: 13, color: Palette.textSecondary, lineHeight: 19 },
  errText: { fontSize: 12, color: Palette.red },

  signedIn: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', backgroundColor: Palette.greenT, borderRadius: Radius.pill, paddingHorizontal: 10, paddingVertical: 6 },
  signedInText: { fontSize: 13, color: Palette.green },
});
