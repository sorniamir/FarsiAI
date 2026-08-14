import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Appearance } from 'react-native';
import Storage from 'expo-sqlite/kv-store';
import { themes, type AppTheme, type ThemeMode } from './theme';

const STORAGE_KEY = 'farsiai-theme-mode';
type ThemeState = { theme: AppTheme; mode: ThemeMode; ready: boolean; setMode: (mode: ThemeMode) => void; toggle: () => void };
const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('dark');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    void Storage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (!mounted) return;
        const next = stored === 'light' ? 'light' : 'dark';
        setModeState(next);
        Appearance.setColorScheme(next);
      })
      .catch(() => undefined)
      .finally(() => { if (mounted) setReady(true); });
    return () => { mounted = false; };
  }, []);

  function setMode(next: ThemeMode) {
    setModeState(next);
    Appearance.setColorScheme(next);
    void Storage.setItem(STORAGE_KEY, next).catch(() => undefined);
  }

  const value = useMemo<ThemeState>(() => ({
    mode,
    theme: themes[mode],
    ready,
    setMode,
    toggle: () => setMode(mode === 'dark' ? 'light' : 'dark'),
  }), [mode, ready]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useAppTheme(): ThemeState {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useAppTheme must be used inside ThemeProvider');
  return value;
}
