import React, { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  View,
} from 'react-native';
import { AppHeader } from './src/components/AppHeader';
import { BottomNav, type MainTab } from './src/components/BottomNav';
import { ModeBar } from './src/components/ModeBar';
import { hasActiveSession, signOut } from './src/services/auth';
import { AuthScreen } from './src/screens/AuthScreen';
import { ChatScreen } from './src/screens/ChatScreen';
import { HistoryScreen } from './src/screens/HistoryScreen';
import { OnboardingScreen } from './src/screens/OnboardingScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';
import { VideoComingSoon } from './src/screens/VideoComingSoon';
import { theme } from './src/theme';
import type { AppMode } from './src/types';

type Stage = 'onboarding' | 'auth' | 'app';

export default function App() {
  const [stage, setStage] = useState<Stage>('onboarding');
  const [tab, setTab] = useState<MainTab>('chat');
  const [mode, setMode] = useState<AppMode>('chat');
  const [isGuest, setIsGuest] = useState(false);
  const [credits] = useState(150);

  useEffect(() => {
    hasActiveSession().then((active) => {
      if (active) {
        setIsGuest(false);
        setStage('app');
      }
    });
  }, []);

  if (stage === 'onboarding') {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" backgroundColor={theme.colors.background} />
        <OnboardingScreen onContinue={() => setStage('auth')} />
      </SafeAreaView>
    );
  }

  if (stage === 'auth') {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" backgroundColor={theme.colors.background} />
        <AuthScreen
          onDone={() => { setIsGuest(false); setTab('chat'); setStage('app'); }}
          onGuest={() => { setIsGuest(true); setTab('chat'); setStage('app'); }}
        />
      </SafeAreaView>
    );
  }

  async function exitAccount() {
    if (!isGuest) await signOut();
    setIsGuest(false);
    setTab('chat');
    setMode('chat');
    setStage('auth');
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={theme.colors.background} />

      {tab === 'chat' ? (
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <AppHeader credits={credits} mode={mode} />
          <ModeBar mode={mode} onChange={setMode} />
          <View style={styles.content}>
            {mode === 'video' ? <VideoComingSoon /> : <ChatScreen mode={mode} onModeChange={setMode} />}
          </View>
        </KeyboardAvoidingView>
      ) : tab === 'history' ? (
        <HistoryScreen onOpenChat={() => setTab('chat')} />
      ) : (
        <ProfileScreen isGuest={isGuest} credits={credits} onSignOut={exitAccount} />
      )}

      <BottomNav tab={tab} onChange={setTab} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  flex: { flex: 1 },
  content: { flex: 1 },
});
