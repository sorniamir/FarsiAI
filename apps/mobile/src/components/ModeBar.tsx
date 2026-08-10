import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAppTheme } from '../ThemeProvider';
import type { AppTheme } from '../theme';
import type { AppMode } from '../types';

const items: Array<{ mode: AppMode; label: string; icon: string; badge?: string }> = [
  { mode: 'chat', label: 'گفتگو', icon: '✦' },
  { mode: 'image', label: 'تصویر', icon: '▧' },
  { mode: 'video', label: 'ویدیو', icon: '▶', badge: 'SOON' },
];

export function ModeBar({ mode, onChange }: { mode: AppMode; onChange: (mode: AppMode) => void }) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={styles.bar}>
      {items.map((item) => {
        const active = item.mode === mode;
        return (
          <Pressable key={item.mode} style={[styles.button, active && styles.active]} onPress={() => onChange(item.mode)}>
            <Text style={[styles.icon, active && styles.activeText]}>{item.icon}</Text>
            <Text style={[styles.label, active && styles.activeText]}>{item.label}</Text>
            {item.badge ? <Text style={styles.badge}>{item.badge}</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const createStyles = (theme: AppTheme) => StyleSheet.create({
  bar: {
    marginHorizontal: 16,
    padding: 4,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 18,
    backgroundColor: theme.colors.surface,
    flexDirection: 'row-reverse',
    gap: 4,
  },
  button: {
    flex: 1,
    minHeight: 42,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row-reverse',
    gap: 6,
  },
  active: { backgroundColor: theme.colors.surfaceRaised },
  icon: { color: theme.colors.textDim, fontSize: 14, fontWeight: '700' },
  label: { color: theme.colors.textMuted, fontSize: 13, fontWeight: '700' },
  activeText: { color: theme.colors.primaryBright },
  badge: { color: theme.colors.warning, fontSize: 8, fontWeight: '800' },
});
