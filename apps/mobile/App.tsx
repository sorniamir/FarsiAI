import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  View,
} from 'react-native';
import { AppHeader } from './src/components/AppHeader';
import { ModeBar } from './src/components/ModeBar';
import { ChatScreen } from './src/screens/ChatScreen';
import { VideoComingSoon } from './src/screens/VideoComingSoon';
import { theme } from './src/theme';
import type { AppMode } from './src/types';

export default function App() {
  const [mode, setMode] = useState<AppMode>('chat');

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={theme.colors.background} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <AppHeader credits={150} mode={mode} />
        <ModeBar mode={mode} onChange={setMode} />
        <View style={styles.content}>
          {mode === 'video' ? <VideoComingSoon /> : <ChatScreen mode={mode} onModeChange={setMode} />}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  flex: { flex: 1 },
  content: { flex: 1 },
});
