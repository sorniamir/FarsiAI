import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

type Props = { children: ReactNode };
type State = { failed: boolean };

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[FarsiAI UI crash]', error.name, info.componentStack?.slice(0, 1200));
  }

  private recover = () => {
    this.setState({ failed: false });
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <View style={styles.screen}>
        <View style={styles.glow} />
        <View style={styles.card}>
          <View style={styles.icon}><Text style={styles.iconText}>✦</Text></View>
          <Text style={styles.eyebrow}>FARSIAI RECOVERY</Text>
          <Text style={styles.title}>رابط کاربری نیاز به بازیابی دارد</Text>
          <Text style={styles.body}>اطلاعات حساب و گفتگوهای Cloud حذف نشده‌اند. رابط برنامه را دوباره بارگذاری می‌کنیم.</Text>
          <Pressable style={styles.button} onPress={this.recover}>
            <Text style={styles.buttonText}>تلاش مجدد</Text>
          </Pressable>
        </View>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#030504', alignItems: 'center', justifyContent: 'center', padding: 24, overflow: 'hidden' },
  glow: { position: 'absolute', width: 360, height: 360, borderRadius: 180, backgroundColor: 'rgba(0,255,174,0.055)' },
  card: { width: '100%', maxWidth: 430, borderRadius: 28, borderWidth: 1, borderColor: 'rgba(0,255,174,0.18)', backgroundColor: 'rgba(11,16,14,0.96)', padding: 26, alignItems: 'center' },
  icon: { width: 62, height: 62, borderRadius: 21, backgroundColor: 'rgba(0,255,174,0.08)', borderWidth: 1, borderColor: 'rgba(0,255,174,0.2)', alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  iconText: { color: '#00ffae', fontSize: 31, fontWeight: '900' },
  eyebrow: { color: '#00ffae', fontSize: 9, fontWeight: '900', letterSpacing: 2, marginBottom: 8 },
  title: { color: '#f2fff9', fontSize: 21, lineHeight: 31, fontWeight: '900', textAlign: 'center', writingDirection: 'rtl' },
  body: { color: '#92a59c', fontSize: 12, lineHeight: 21, textAlign: 'center', writingDirection: 'rtl', marginTop: 9, marginBottom: 20 },
  button: { width: '100%', height: 52, borderRadius: 17, backgroundColor: '#00ffae', alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: '#002318', fontSize: 14, fontWeight: '900' },
});
