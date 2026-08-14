import { useState } from 'react';
import { requestPasswordReset, resendEmailConfirmation } from '../services/auth';

type RecoveryAction = 'password' | 'verify';

export function AccountRecoveryLauncher() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [success, setSuccess] = useState(false);

  async function run(action: RecoveryAction) {
    if (busy) return;
    setBusy(true);
    setStatus('');
    setSuccess(false);
    const result = action === 'password'
      ? await requestPasswordReset(email)
      : await resendEmailConfirmation(email);
    setBusy(false);
    if (!result.ok) {
      setStatus(result.message);
      return;
    }
    setSuccess(true);
    setStatus(action === 'password'
      ? 'لینک امن بازیابی رمز ارسال شد. ایمیل را باز کن و رمز جدید بساز.'
      : 'ایمیل تأیید جدید ارسال شد. پوشه Spam را هم بررسی کن.');
  }

  function close() {
    if (busy) return;
    setOpen(false);
    setStatus('');
    setSuccess(false);
  }

  return (
    <div className="account-recovery-layer">
      <button className="account-recovery-trigger" type="button" onClick={() => setOpen(true)}>بازیابی حساب</button>
      {open ? (
        <div className="account-recovery-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) close(); }}>
          <section className="account-recovery-modal" role="dialog" aria-modal="true" aria-labelledby="account-recovery-title">
            <button className="account-recovery-close" type="button" onClick={close} aria-label="بستن">×</button>
            <div className="account-recovery-mark">✦</div>
            <span>ACCOUNT SECURITY</span>
            <h2 id="account-recovery-title">بازیابی حساب FarsiAI</h2>
            <p>ایمیل حسابت را وارد کن. لینک بازیابی از مسیر امن Supabase Auth ارسال می‌شود و رمز در FarsiAI ذخیره نمی‌شود.</p>
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              inputMode="email"
              autoComplete="email"
              dir="ltr"
              placeholder="you@example.com"
              disabled={busy}
            />
            {status ? <div className={success ? 'account-recovery-status ok' : 'account-recovery-status error'}>{status}</div> : null}
            <div className="account-recovery-actions">
              <button className="primary" type="button" disabled={busy} onClick={() => void run('password')}>{busy ? '…' : 'ارسال لینک بازیابی رمز'}</button>
              <button className="secondary" type="button" disabled={busy} onClick={() => void run('verify')}>ارسال مجدد تأیید ایمیل</button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
