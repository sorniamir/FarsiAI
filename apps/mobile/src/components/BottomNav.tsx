import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { theme } from '../theme';

export type MainTab = 'chat' | 'history' | 'profile';

const tabs: { id: MainTab; icon: string; label: string }[] = [
  { id: 'chat', icon: '✦', label: 'هوش مصنوعی' },
  { id: 'history', icon: '◷', label: 'تاریخچه' },
  { id: 'profile', icon: '◉', label: 'حساب' },
];

export function BottomNav({ tab, onChange }: { tab: MainTab; onChange: (tab: MainTab) => void }) {
  return (
    <View style={styles.wrap}>
      {tabs.map((item) => {
        const active = item.id === tab;
        return (
          <TouchableOpacity key={item.id} style={styles.item} onPress={() => onChange(item.id)} activeOpacity={0.8}>
            <View style={[styles.iconWrap, active && styles.iconActive]}><Text style={[styles.icon, active && styles.active]}>{item.icon}</Text></View>
            <Text style={[styles.label, active && styles.active]}>{item.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row-reverse', backgroundColor: theme.colors.surface, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8, paddingBottom: 8 },
  item: { flex: 1, alignItems: 'center', gap: 3 },
  iconWrap: { width: 34, height: 28, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  iconActive: { backgroundColor: 'rgba(139,92,246,0.14)' },
  icon: { color: theme.colors.textDim, fontSize: 17, fontWeight: '900' },
  label: { color: theme.colors.textDim, fontSize: 10, fontWeight: '800' },
  active: { color: theme.colors.primaryBright },
});
