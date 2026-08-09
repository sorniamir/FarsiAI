import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Appearance } from 'react-native';
import { themes, type AppTheme, type ThemeMode } from './theme';

const STORAGE_KEY = 'farsiai-theme-mode';
type ThemeState = { theme: AppTheme; mode: ThemeMode; setMode: (mode: ThemeMode) => void; toggle: () => void };
const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('dark');

  useEffect(() => {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') setModeState(stored);
  }, []);

  function setMode(next: ThemeMode) {
    setModeState(next);
    Appearance.setColorScheme(next);
    globalThis.localStorage?.setItem(STORAGE_KEY, next);
  }

  const value = useMemo<ThemeState>(() => ({
    mode,
    theme: themes[mode],
    setMode,
    toggle: () => setMode(mode === 'dark' ? 'light' : 'dark'),
  }), [mode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useAppTheme(): ThemeState {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useAppTheme must be used inside ThemeProvider');
  return value;
}
