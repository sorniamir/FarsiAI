import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';
import './styles/codex-studio.css';
import './styles/chat-v046.css';
import './styles/commercial-v060.css';
import './styles/chat-commercial-v060.css';
import './styles/voice-commercial-v060.css';

type ThemeMode = 'dark' | 'light';
const THEME_STORAGE_KEY = 'farsiai.theme';

function initialTheme(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function ThemedApp() {
  const [theme, setTheme] = React.useState<ThemeMode>(initialTheme);

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { window.localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* private mode */ }
  }, [theme]);

  return (
    <>
      <App />
      <button
        type="button"
        className="global-theme-toggle"
        aria-label={theme === 'dark' ? 'فعال کردن حالت روشن' : 'فعال کردن حالت تاریک'}
        title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
        onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
      >
        {theme === 'dark' ? '☀' : '☾'}
      </button>
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemedApp />
  </React.StrictMode>,
);
