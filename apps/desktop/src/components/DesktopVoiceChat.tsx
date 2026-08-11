import { useEffect, useRef, useState } from 'react';
import { transcribeVoice } from '../services/voice';

type VoiceTurn = { id: string; role: 'user' | 'assistant'; text: string };
type AskResult = { ok: true; text: string } | { ok: false; error: string };
type VoiceStatus = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error';

const MAX_RECORDING_MS = 45_000;

function supportedRecordingType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return candidates.find((value) => MediaRecorder.isTypeSupported(value)) || '';
}

export function DesktopVoiceChat({ ask, remaining }: { ask: (text: string) => Promise<AskResult>; remaining: number }) {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [partial, setPartial] = useState('');
  const [manual, setManual] = useState('');
  const [error, setError] = useState('');
  const [turns, setTurns] = useState<VoiceTurn[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<number | null>(null);
  const requestAbortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);

  function releaseMicrophone() {
    if (recordingTimerRef.current !== null) window.clearTimeout(recordingTimerRef.current);
    recordingTimerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }

  useEffect(() => () => {
    aliveRef.current = false;
    requestAbortRef.current?.abort();
    const recorder = recorderRef.current;
    if (recorder?.state === 'recording') recorder.stop();
    releaseMicrophone();
    window.speechSynthesis?.cancel();
  }, []);

  function stopAll() {
    const recorder = recorderRef.current;
    if (recorder?.state === 'recording') {
      recorder.stop();
      return;
    }
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    window.speechSynthesis?.cancel();
    releaseMicrophone();
    setPartial('');
    setStatus('idle');
  }

  function speak(text: string) {
    if (!('speechSynthesis' in window)) {
      setStatus('idle');
      setError('موتور پخش گفتار روی این نسخه ویندوز در دسترس نیست؛ متن پاسخ نمایش داده شده است.');
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'fa-IR';
    utterance.rate = 0.92;
    utterance.pitch = 1;
    utterance.onstart = () => aliveRef.current && setStatus('speaking');
    utterance.onend = () => aliveRef.current && setStatus('idle');
    utterance.onerror = () => {
      if (!aliveRef.current) return;
      setStatus('error');
      setError('پخش پاسخ صوتی ناموفق بود؛ متن پاسخ همچنان در دسترس است.');
    };
    window.speechSynthesis.speak(utterance);
  }

  async function send(textValue: string) {
    const text = textValue.trim();
    if (!text || status === 'thinking') return;
    setError('');
    setPartial('');
    setManual('');
    setTurns((current) => [...current, { id: `u-${Date.now()}`, role: 'user', text }]);
    setStatus('thinking');
    const result = await ask(text);
    if (!aliveRef.current) return;
    if (!result.ok) {
      setStatus('error');
      setError(result.error);
      return;
    }
    setTurns((current) => [...current, { id: `a-${Date.now()}`, role: 'assistant', text: result.text }]);
    speak(result.text);
  }

  async function processRecording(blob: Blob) {
    setStatus('transcribing');
    setPartial('در حال تبدیل گفتار فارسی به متن…');
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const result = await transcribeVoice(blob, controller.signal);
    requestAbortRef.current = null;
    if (!aliveRef.current || controller.signal.aborted) return;
    if (!result.ok) {
      setPartial('');
      setStatus('error');
      const diagnostic = [result.code, result.requestId ? `request: ${result.requestId}` : ''].filter(Boolean).join(' · ');
      setError(`${result.error}${diagnostic ? ` (${diagnostic})` : ''}`);
      return;
    }
    setPartial(result.text);
    await send(result.text);
  }

  async function startListening() {
    setError('');
    setPartial('');
    window.speechSynthesis?.cancel();

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setStatus('error');
      setError('ضبط میکروفن در WebView2 این سیستم در دسترس نیست. WebView2 Runtime و Windows را به‌روز کنید.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      if (!aliveRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const mimeType = supportedRecordingType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 }) : new MediaRecorder(stream);
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        releaseMicrophone();
        if (!aliveRef.current) return;
        setStatus('error');
        setError('ضبط صدا ناموفق بود؛ دسترسی میکروفن ویندوز را بررسی کنید.');
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        releaseMicrophone();
        if (aliveRef.current) void processRecording(blob);
      };
      recorder.start(250);
      setStatus('listening');
      setPartial('در حال ضبط… برای ارسال دوباره حلقه را لمس کن.');
      recordingTimerRef.current = window.setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, MAX_RECORDING_MS);
    } catch (caught) {
      releaseMicrophone();
      setStatus('error');
      const name = caught instanceof DOMException ? caught.name : '';
      setError(
        name === 'NotAllowedError' || name === 'PermissionDeniedError'
          ? 'دسترسی میکروفن داده نشد. در Windows Settings > Privacy > Microphone دسترسی برنامه‌های دسکتاپ را فعال کنید.'
          : `میکروفن قابل استفاده نیست${caught instanceof Error && caught.message ? `: ${caught.message}` : '.'}`,
      );
    }
  }

  const busy = status === 'listening' || status === 'transcribing' || status === 'thinking' || status === 'speaking';
  const canInterrupt = status === 'listening' || status === 'transcribing' || status === 'speaking';
  const labels: Record<VoiceStatus, string> = {
    idle: 'آماده گفت‌وگو',
    listening: 'در حال ضبط صدا…',
    transcribing: 'در حال پردازش گفتار…',
    thinking: 'AI در حال فکرکردن…',
    speaking: 'در حال پاسخ‌گویی صوتی…',
    error: 'نیاز به بررسی',
  };

  return (
    <section className="desktop-voice-layout">
      <div className="desktop-voice-main glass">
        <div className="voice-heading"><div><h2>Voice Chat Live</h2><p>فارسی صحبت کن؛ صدای واقعی ضبط و پردازش می‌شود و پاسخ را هم به‌صورت صوتی و متن دریافت می‌کنی.</p></div><span>{remaining} پیام باقی‌مانده</span></div>
        <div className="voice-orb-stage">
          <div className={`voice-orb-shell ${busy ? 'active' : ''}`}>
            <button
              className={`voice-orb ${status}`}
              disabled={status === 'thinking'}
              onClick={status === 'idle' || status === 'error' ? startListening : canInterrupt ? stopAll : undefined}
              aria-label={status === 'listening' ? 'پایان ضبط و ارسال' : 'شروع ضبط صدا'}
            >{status === 'thinking' || status === 'transcribing' ? '…' : busy ? '■' : '●'}</button>
          </div>
          <strong>{labels[status]}</strong>
          <small>{status === 'listening' ? 'صحبتت که تمام شد، حلقه را دوباره لمس کن تا ارسال شود' : busy ? 'برای توقف فوری حلقه را لمس کن' : 'حلقه را لمس کن و طبیعی صحبت کن'}</small>
          {partial ? <div className="desktop-live-transcript"><b>{status === 'listening' ? 'REC' : 'LIVE'}</b><span>{partial}</span></div> : null}
          {error ? <div className="desktop-voice-error">{error}</div> : null}
        </div>
        <div className="desktop-voice-turns">
          {turns.length === 0 ? <div className="voice-empty"><strong>مکالمه بدون تایپ</strong><span>یک‌بار برای شروع ضبط و بار دوم برای پایان و ارسال لمس کن. زمان هر پیام صوتی حداکثر ۴۵ ثانیه است.</span></div> : turns.map((turn) => <article key={turn.id} className={`voice-turn ${turn.role}`}><b>{turn.role === 'user' ? 'شما' : 'FarsiAI Voice'}</b><p>{turn.text}</p>{turn.role === 'assistant' ? <button onClick={() => speak(turn.text)}>↻ پخش دوباره</button> : null}</article>)}
        </div>
        <div className="desktop-voice-composer"><textarea value={manual} onChange={(event) => setManual(event.target.value)} placeholder="یا پیام را اینجا بنویس…" /><button className="primary" disabled={!manual.trim() || status === 'thinking' || status === 'transcribing'} onClick={() => void send(manual)}>ارسال</button></div>
      </div>
      <aside className="inspector glass voice-inspector"><h3>کنترل مکالمه</h3><FeatureLine title="Microphone" value={navigator.mediaDevices ? 'Recorder ready' : 'Unavailable'} ready={Boolean(navigator.mediaDevices)} /><FeatureLine title="Persian ASR" value="Whisper v3 Turbo" ready /><FeatureLine title="Noise control" value="Enabled" ready /><FeatureLine title="Text transcript" value="Enabled" ready /><div className="divider" /><h3>حریم خصوصی</h3><p>میکروفن فقط با لمس حلقه فعال می‌شود. صدای ضبط‌شده برای تبدیل گفتار به متن به API امن FarsiAI ارسال می‌شود و پس از پردازش در برنامه نگهداری نمی‌شود.</p></aside>
    </section>
  );
}

function FeatureLine({ title, value, ready }: { title: string; value: string; ready?: boolean }) {
  return <div className={ready ? 'feature-card ready' : 'feature-card'}><strong>{title}</strong><span>{value}</span></div>;
}
