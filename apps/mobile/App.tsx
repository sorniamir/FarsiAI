import React, { useEffect, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  View,
} from 'react-native';
import { AppErrorBoundary } from './src/components/AppErrorBoundary';
import { AppHeader } from './src/components/AppHeader';
import { BottomNav, type MainTab } from './src/components/BottomNav';
import { ModeBar } from './src/components/ModeBar';
import { createSessionFromUrl, getCurrentUserEmail, hasActiveSession, signOut } from './src/services/auth';
import { getAccountPlan, type AccountPlan } from './src/services/account';
import { DEFAULT_DAILY_QUOTA, getAuthenticatedQuota, getGuestQuota } from './src/services/quota';
import { AuthScreen } from './src/screens/AuthScreen';
import { ChatScreen } from './src/screens/ChatScreen';
import { HistoryScreen } from './src/screens/HistoryScreen';
import { ImageStudioScreen } from './src/screens/ImageStudioScreen';
import { OnboardingScreen } from './src/screens/OnboardingScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';
import { VideoComingSoon } from './src/screens/VideoComingSoon';
import { ThemeProvider, useAppTheme } from './src/ThemeProvider';
import type { AppTheme } from './src/theme';
import type { AppMode, DailyQuota } from './src/types';

type Stage = 'onboarding' | 'auth' | 'app';

export default function App() {
  return (
    <AppErrorBoundary>
      <ThemeProvider><AppContent /></ThemeProvider>
    </AppErrorBoundary>
  );
}

function AppContent() {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [stage, setStage] = useState<Stage>('onboarding');
  const [tab, setTab] = useState<MainTab>('chat');
  const [mode, setMode] = useState<AppMode>('chat');
  const [isGuest, setIsGuest] = useState(false);
  const [quota, setQuota] = useState<DailyQuota>(DEFAULT_DAILY_QUOTA);
  const [userEmail, setUserEmail] = useState<string | undefined>();
  const [accountPlan, setAccountPlan] = useState<AccountPlan>('free');
  const [conversationId, setConversationId] = useState<string | undefined>();

  useEffect(() => {
    hasActiveSession().then(async (active) => {
      if (!active) return;
      const [email, nextQuota, nextPlan] = await Promise.all([
        getCurrentUserEmail(),
        getAuthenticatedQuota(),
        getAccountPlan(),
      ]);
      setIsGuest(false);
      setUserEmail(email);
      setQuota(nextQuota);
      setAccountPlan(nextPlan);
      setStage('app');
    });
  }, []);

  useEffect(() => {
    async function handleUrl(url: string | null) {
      if (!url?.startsWith('farsiai://auth')) return;
      const result = await createSessionFromUrl(url);
      if (result.ok) await enterAuthenticatedApp();
    }
    Linking.getInitialURL().then(handleUrl);
    const subscription = Linking.addEventListener('url', ({ url }) => handleUrl(url));
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (stage !== 'app' || isGuest || tab !== 'profile') return;
    let mounted = true;
    void Promise.all([getAuthenticatedQuota(), getAccountPlan()]).then(([nextQuota, nextPlan]) => {
      if (!mounted) return;
      setQuota(nextQuota);
      setAccountPlan(nextPlan);
    });
    return () => { mounted = false; };
  }, [stage, isGuest, tab]);

  async function enterAuthenticatedApp() {
    const [email, nextQuota, nextPlan] = await Promise.all([
      getCurrentUserEmail(),
      getAuthenticatedQuota(),
      getAccountPlan(),
    ]);
    setIsGuest(false);
    setTab('chat');
    setConversationId(undefined);
    setUserEmail(email);
    setQuota(nextQuota);
    setAccountPlan(nextPlan);
    setStage('app');
  }

  function enterGuestApp() {
    setIsGuest(true);
    setUserEmail(undefined);
    setAccountPlan('free');
    setQuota(getGuestQuota());
    setTab('chat');
    setConversationId(undefined);
    setStage('app');
  }

  if (stage === 'onboarding') {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle={theme.mode === 'dark' ? 'light-content' : 'dark-content'} backgroundColor={theme.colors.background} />
        <OnboardingScreen onContinue={() => setStage('auth')} />
      </SafeAreaView>
    );
  }

  if (stage === 'auth') {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle={theme.mode === 'dark' ? 'light-content' : 'dark-content'} backgroundColor={theme.colors.background} />
        <AuthScreen onDone={enterAuthenticatedApp} onGuest={enterGuestApp} />
      </SafeAreaView>
    );
  }

  async function exitAccount() {
    if (!isGuest) await signOut();
    setIsGuest(false);
    setUserEmail(undefined);
    setAccountPlan('free');
    setQuota(DEFAULT_DAILY_QUOTA);
    setTab('chat');
    setMode('chat');
    setStage('auth');
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle={theme.mode === 'dark' ? 'light-content' : 'dark-content'} backgroundColor={theme.colors.background} />

      {tab === 'chat' ? (
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <AppHeader quota={quota} mode={mode} />
          <ModeBar mode={mode} onChange={setMode} />
          <View style={styles.content}>
            {mode === 'video' ? (
              <VideoComingSoon />
            ) : (
              <ChatScreen key={conversationId ?? 'new'} initialConversationId={conversationId} mode={mode} isGuest={isGuest} quota={quota} onModeChange={setMode} onQuotaChange={setQuota} onRequireAccount={() => setStage('auth')} />
            )}
          </View>
        </KeyboardAvoidingView>
      ) : tab === 'studio' ? (
        <ImageStudioScreen
          isGuest={isGuest}
          onCreateImage={() => {
            setConversationId(undefined);
            setMode('image');
            setTab('chat');
          }}
          onOpenConversation={(id) => {
            setConversationId(id);
            setMode('image');
            setTab('chat');
          }}
          onRequireAccount={() => setStage('auth')}
        />
      ) : tab === 'history' ? (
        <HistoryScreen onOpenChat={(id) => { setConversationId(id); setTab('chat'); }} />
      ) : (
        <ProfileScreen isGuest={isGuest} email={userEmail} quota={quota} plan={accountPlan} onSignOut={exitAccount} />
      )}

      <BottomNav tab={tab} onChange={setTab} />
    </SafeAreaView>
  );
}

const createStyles = (theme: AppTheme) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  flex: { flex: 1 },
  content: { flex: 1 },
});
