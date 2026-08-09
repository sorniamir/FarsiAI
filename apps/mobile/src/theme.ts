export type ThemeMode = 'dark' | 'light';

const shared = {
  radius: { sm: 12, md: 18, lg: 24, xl: 30, pill: 999 },
  spacing: { xs: 6, sm: 10, md: 16, lg: 22, xl: 30 },
  fonts: { regular: 'Vazirmatn', bold: 'VazirmatnBold' },
} as const;

export const themes = {
  dark: {
    ...shared,
    mode: 'dark' as const,
    colors: {
      background: '#000000', surface: '#0A0D0C', surfaceRaised: '#101412', surfaceSoft: '#18201D',
      primary: '#00FFAE', primaryBright: '#00FFAE', cyan: '#00FFAE', text: '#FFFFFF',
      textMuted: '#A5B0AB', textDim: '#66736E', border: 'rgba(255,255,255,0.11)',
      userBubble: '#163B30', assistantBubble: '#0A0D0C', success: '#00FFAE', warning: '#F7C873', danger: '#FF6B7A',
      onAccent: '#001A11', accentSoft: 'rgba(0,255,174,0.10)',
    },
  },
  light: {
    ...shared,
    mode: 'light' as const,
    colors: {
      background: '#F7F8F6', surface: '#FFFFFF', surfaceRaised: '#FFFFFF', surfaceSoft: '#E8EEEB',
      primary: '#00B97C', primaryBright: '#008F61', cyan: '#008F61', text: '#101412',
      textMuted: '#53615B', textDim: '#819089', border: 'rgba(16,20,18,0.12)',
      userBubble: '#D8F8EC', assistantBubble: '#FFFFFF', success: '#008F61', warning: '#9B6A00', danger: '#D93F53',
      onAccent: '#001A11', accentSoft: 'rgba(0,185,124,0.11)',
    },
  },
} as const;

export type AppTheme = (typeof themes)[ThemeMode];
export const theme = themes.dark;
