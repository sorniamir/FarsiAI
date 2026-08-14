import React, { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { failed: boolean };

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[FarsiAI UI crash]', error.name, info.componentStack?.slice(0, 1400));
  }

  private retry = () => {
    this.setState({ failed: false });
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="fatal-recovery-shell">
        <div className="fatal-recovery-ambient" />
        <section className="fatal-recovery-card">
          <div className="fatal-recovery-icon">✦</div>
          <span>FARSIAI RECOVERY</span>
          <h1>رابط برنامه نیاز به بازیابی دارد</h1>
          <p>حساب، گفتگوها و پروژه‌های Codex حذف نشده‌اند. رابط را دوباره راه‌اندازی کن؛ اگر مشکل تکرار شد برنامه را یک‌بار ببند و باز کن.</p>
          <div className="fatal-recovery-actions">
            <button className="primary" onClick={this.retry}>تلاش مجدد</button>
            <button className="secondary" onClick={() => window.location.reload()}>Reload کامل</button>
          </div>
        </section>
      </div>
    );
  }
}
