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
import { AppHeader } from './src/components/AppHeader';
import { BottomNav, type MainTab } from './src/components/BottomNav';
import { ModeBar } from './src/components/ModeBar';
import { getCreditBalance } from './src/services/account';
import { createSessionFromUrl, hasActiveSession, signOut } from './src/services/auth';
import { AuthScreen } from './src/screens/AuthScreen';
import { ChatScreen } from './src/screens/ChatScreen';
import { HistoryScreen } from './src/screens/HistoryScreen';
import { OnboardingScreen } from './src/screens/OnboardingScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';
import { VideoComingSoon } from './src/screens/VideoComingSoon';
import { ThemeProvider, useAppTheme } from './src/ThemeProvider';
import type { AppTheme } from './src/theme';
import type { AppMode } from './src/types';

type Stage = 'onboarding' | 'auth' | 'app';
const GUEST_CREDITS = 150;

export default function App() {
  return <ThemeProvider><AppContent /></ThemeProvider>;
}

function AppContent() {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [stage, setStage] = useState<Stage>('onboarding');
  const [tab, setTab] = useState<MainTab>('chat');
  const [mode, setMode] = useState<AppMode>('chat');
  const [isGuest, setIsGuest] = useState(false);
  const [credits, setCredits] = useState(GUEST_CREDITS);
  const [conversationId, setConversationId] = useState<string | undefined>();

  useEffect(() => {
    hasActiveSession().then(async (active) => {
      if (!active) return;
      setIsGuest(false);
      const balance = await getCreditBalance();
      if (balance !== null) setCredits(balance);
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

  async function enterAuthenticatedApp() {
    setIsGuest(false);
    setTab('chat');
    setConversationId(undefined);
    const balance = await getCreditBalance();
    setCredits(balance ?? GUEST_CREDITS);
    setStage('app');
  }

  function enterGuestApp() {
    setIsGuest(true);
    setCredits(GUEST_CREDITS);
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
    setCredits(GUEST_CREDITS);
    setTab('chat');
    setMode('chat');
    setStage('auth');
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle={theme.mode === 'dark' ? 'light-content' : 'dark-content'} backgroundColor={theme.colors.background} />

      {tab === 'chat' ? (
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <AppHeader credits={credits} mode={mode} />
          <ModeBar mode={mode} onChange={setMode} />
          <View style={styles.content}>
            {mode === 'video' ? (
              <VideoComingSoon />
            ) : (
              <ChatScreen key={conversationId ?? 'new'} initialConversationId={conversationId} mode={mode} onModeChange={setMode} onCreditsChange={setCredits} />
            )}
          </View>
        </KeyboardAvoidingView>
      ) : tab === 'history' ? (
        <HistoryScreen onOpenChat={(id) => { setConversationId(id); setTab('chat'); }} />
      ) : (
        <ProfileScreen isGuest={isGuest} credits={credits} onSignOut={exitAccount} />
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
