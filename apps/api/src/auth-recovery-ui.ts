import type { Env } from './types';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char] || char);
}

export function renderPasswordRecovery(env: Env): Response {
  const supabaseUrl = env.SUPABASE_URL?.replace(/\/$/, '') || '';
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY || '';
  const configured = Boolean(supabaseUrl && publishableKey);
  const config = JSON.stringify({ supabaseUrl, publishableKey, configured }).replace(/</g, '\\u003c');

  const html = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <meta name="color-scheme" content="dark light" />
  <title>بازیابی رمز FarsiAI</title>
  <style>
    :root{color-scheme:dark;background:#050706;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    *{box-sizing:border-box} body{margin:0;min-height:100vh;color:#eefbf6;background:radial-gradient(circle at 18% 18%,rgba(0,255,174,.12),transparent 28%),radial-gradient(circle at 80% 72%,rgba(0,255,174,.06),transparent 32%),linear-gradient(150deg,#020403,#090d0b 60%,#020403);display:grid;place-items:center;padding:24px;overflow:hidden}
    body:before{content:"";position:fixed;inset:-25%;background-image:linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.018) 1px,transparent 1px);background-size:48px 48px;transform:perspective(700px) rotateX(64deg) translateY(32%);mask-image:linear-gradient(to bottom,transparent,#000 28%,#000 70%,transparent);pointer-events:none}
    .card{position:relative;width:min(460px,100%);border:1px solid rgba(0,255,174,.16);border-radius:28px;background:linear-gradient(180deg,rgba(18,24,21,.86),rgba(5,8,7,.94));box-shadow:0 30px 100px rgba(0,0,0,.58),inset 0 1px rgba(255,255,255,.04);backdrop-filter:blur(26px);padding:30px}
    .brand{display:flex;align-items:center;gap:12px;margin-bottom:28px}.mark{width:42px;height:42px;border-radius:14px;display:grid;place-items:center;background:rgba(0,255,174,.09);border:1px solid rgba(0,255,174,.22);color:#00ffae;font-size:22px;box-shadow:0 0 38px rgba(0,255,174,.12)}.brand strong{display:block;font-size:17px}.brand span{display:block;color:#83968e;font-size:11px;margin-top:2px;letter-spacing:.08em}
    h1{font-size:27px;margin:0 0 8px}p{margin:0 0 24px;color:#95a69e;line-height:1.9;font-size:13px}.field{display:grid;gap:8px;margin:14px 0}.field label{font-size:12px;color:#b9c9c2}.input{width:100%;height:52px;border:1px solid rgba(255,255,255,.09);border-radius:16px;background:rgba(255,255,255,.035);color:#fff;padding:0 15px;outline:none;font-size:15px;direction:ltr}.input:focus{border-color:rgba(0,255,174,.45);box-shadow:0 0 0 3px rgba(0,255,174,.06)}
    button{width:100%;height:52px;border:0;border-radius:16px;background:#00ffae;color:#001b12;font-weight:900;font-size:14px;cursor:pointer;margin-top:10px;box-shadow:0 10px 30px rgba(0,255,174,.13)}button:disabled{opacity:.45;cursor:not-allowed}.status{display:none;margin-top:16px;padding:13px 14px;border-radius:14px;font-size:12px;line-height:1.8}.status.show{display:block}.status.error{background:rgba(255,83,83,.08);border:1px solid rgba(255,83,83,.18);color:#ffb0b0}.status.ok{background:rgba(0,255,174,.07);border:1px solid rgba(0,255,174,.18);color:#8fffd8}.fine{margin-top:18px;color:#65766e;font-size:10px;text-align:center;line-height:1.8}.hidden{display:none!important}
    @media(prefers-color-scheme:light){:root{background:#eef4f1}body{color:#0c1813;background:radial-gradient(circle at 18% 18%,rgba(0,185,124,.13),transparent 28%),linear-gradient(150deg,#f7fbf9,#e9f0ed)}.card{background:rgba(255,255,255,.9);border-color:rgba(0,145,99,.2);box-shadow:0 24px 90px rgba(13,40,29,.14)}.input{background:#f7faf8;color:#0d1713;border-color:rgba(0,0,0,.1)}p,.brand span{color:#5d7168}.field label{color:#42564d}.fine{color:#74867e}}
  </style>
</head>
<body>
  <main class="card">
    <div class="brand"><div class="mark">✦</div><div><strong>FarsiAI</strong><span>ACCOUNT SECURITY</span></div></div>
    <section id="formPanel">
      <h1>رمز جدید بساز</h1>
      <p>رمز جدید فقط از طریق Supabase Auth ثبت می‌شود. FarsiAI رمز عبور شما را ذخیره یا مشاهده نمی‌کند.</p>
      <div class="field"><label for="password">رمز جدید</label><input class="input" id="password" type="password" autocomplete="new-password" minlength="8" placeholder="حداقل ۸ کاراکتر" /></div>
      <div class="field"><label for="confirm">تکرار رمز جدید</label><input class="input" id="confirm" type="password" autocomplete="new-password" minlength="8" placeholder="تکرار رمز" /></div>
      <button id="submit" type="button">ثبت رمز جدید</button>
    </section>
    <div id="status" class="status"></div>
    <div class="fine">این صفحه فقط برای لینک بازیابی معتبر فعال می‌شود. توکن بازیابی در URL مرورگر پردازش می‌شود و در سرور FarsiAI ذخیره نمی‌شود.</div>
  </main>
<script>
(() => {
  const config=${config};
  const status=document.getElementById('status');
  const panel=document.getElementById('formPanel');
  const submit=document.getElementById('submit');
  const password=document.getElementById('password');
  const confirm=document.getElementById('confirm');
  const show=(message,kind)=>{status.textContent=message;status.className='status show '+kind};
  const params=new URLSearchParams(location.hash.replace(/^#/,''));
  const query=new URLSearchParams(location.search);
  const accessToken=params.get('access_token')||query.get('access_token');
  const type=params.get('type')||query.get('type');
  const error=params.get('error_description')||query.get('error_description');
  if(!config.configured){panel.classList.add('hidden');show('سرویس بازیابی حساب هنوز روی سرور تنظیم نشده است.','error');return}
  if(error){panel.classList.add('hidden');show(decodeURIComponent(error),'error');return}
  if(!accessToken||type!=='recovery'){panel.classList.add('hidden');show('لینک بازیابی معتبر نیست یا منقضی شده است. از داخل FarsiAI یک لینک جدید درخواست کنید.','error');return}
  history.replaceState(null,'',location.pathname);
  submit.addEventListener('click',async()=>{
    const next=String(password.value||'');
    if(next.length<8){show('رمز جدید باید حداقل ۸ کاراکتر باشد.','error');return}
    if(next!==confirm.value){show('تکرار رمز با رمز جدید یکسان نیست.','error');return}
    submit.disabled=true;submit.textContent='در حال ثبت…';
    try{
      const response=await fetch(config.supabaseUrl+'/auth/v1/user',{method:'PUT',headers:{'content-type':'application/json','apikey':config.publishableKey,'authorization':'Bearer '+accessToken},body:JSON.stringify({password:next})});
      if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.msg||body.message||'ثبت رمز جدید انجام نشد.')}
      panel.classList.add('hidden');show('رمز با موفقیت تغییر کرد. حالا می‌توانید با رمز جدید وارد FarsiAI شوید.','ok');
    }catch(err){show(err instanceof Error?err.message:'ثبت رمز جدید انجام نشد.','error');submit.disabled=false;submit.textContent='ثبت رمز جدید'}
  });
})();
</script>
</body></html>`;

  return new Response(html, {
    status: configured ? 200 : 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src https:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      'cross-origin-opener-policy': 'same-origin',
    },
  });
}
