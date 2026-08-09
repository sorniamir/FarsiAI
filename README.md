# FarsiAI — Product MVP 0.3

اپ هوش مصنوعی فارسی با چت، ساخت تصویر داخل همان گفتگو، حساب کاربری، تاریخچه، Credit Wallet و بخش ویدیو (Coming Soon).

## معماری

- `apps/mobile`: React Native + Expo 57
- `apps/api`: Cloudflare Worker + Workers AI
- `supabase/migrations`: منبع اصلی و نسخه‌بندی‌شده‌ی دیتابیس Supabase
- `supabase/config.toml`: تنظیمات local/preview Supabase
- `docs`: معماری و Deployment

## AI Flow

- Chat: Persian input → M2M100 → Qwen3 → M2M100 → Persian output
- Image: Persian prompt → M2M100 → FLUX.1 Schnell → image
- API keys و کلیدهای privileged فقط در Backend نگهداری می‌شوند.

## Product Flow

`Onboarding → Login / Guest → Chat | History | Profile`

- Chat و Image Mode در یک محیط
- Video AI به‌صورت Coming Soon
- Guest Mode برای ورود سریع
- Supabase Auth به‌صورت env-based
- Credit Wallet و Ledger برای محدودیت مصرف و اشتراک آینده
- Session کاربران لاگین‌شده همراه درخواست AI ارسال و در Worker اعتبارسنجی می‌شود
- Credit کاربران لاگین‌شده فقط از Backend کم/برگردانده می‌شود
- Conversation و پیام‌های کاربران لاگین‌شده به‌صورت server-side ذخیره می‌شوند
- Cloudflare Rate Limiting برای Chat و Image فعال است

## اجرای محلی

```bash
npm install
npm run check
```

### API

```bash
cd apps/api
npx wrangler dev
```

### Mobile

```bash
cd apps/mobile
EXPO_PUBLIC_API_URL=http://YOUR-LAN-IP:8787 npx expo start
```

## Supabase Deployment

تغییرات دیتابیس را مستقیماً در SQL Editor تولید نکن. از این نسخه به بعد همه تغییرات schema باید migration باشند:

```text
supabase/migrations/<timestamp>_<name>.sql
```

اگر GitHub Integration پروژه Supabase روی این repository فعال باشد و `Deploy to production` روشن باشد، migrationهای جدید پس از merge به branch اصلی توسط Supabase اعمال می‌شوند.

Database CI نیز قبل از merge migrationها را روی دیتابیس محلی از صفر replay و lint می‌کند.

متغیرهای عمومی موبایل:

```env
EXPO_PUBLIC_SUPABASE_URL=...
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
EXPO_PUBLIC_API_URL=...
```

متغیرهای Worker:

```env
SUPABASE_URL=...
SUPABASE_PUBLISHABLE_KEY=...
```

Secret سمت Worker، ترجیحاً کلید جدید Supabase:

```text
SUPABASE_SECRET_KEY=sb_secret_...
```

برای پروژه‌های legacy، `SUPABASE_SERVICE_ROLE_KEY` فقط به‌عنوان fallback پشتیبانی می‌شود. هیچ Secret privileged نباید وارد اپ موبایل یا Git شود.

## Cloudflare Deployment

Worker در `apps/api` قرار دارد. برای Workers Builds، repository را به Cloudflare متصل کن و Root directory را `apps/api` قرار بده. Production branch باید `main` باشد و deploy command می‌تواند همان `npx wrangler deploy` باشد.

Worker شامل:

- Workers AI binding
- Chat rate limiter: 30 request/minute per verified user / guest actor
- Image rate limiter: 6 request/minute per verified user / guest actor
- Workers Observability logs
- structured logs بدون ذخیره متن Prompt
- Supabase access-token verification
- server-side credit charging + automatic refund on AI failure
- server-side conversation/message persistence

## Credit Cost فعلی

- Chat: `1` Credit
- Image: `20` Credits
- Welcome balance: `150` Credits

این اعداد فعلاً Product Defaults هستند و قبل از لانچ عمومی بر اساس مصرف واقعی AI قابل تنظیم‌اند.

## وضعیت v0.3

- Persian Chat UI: آماده
- Image Mode: آماده
- Onboarding / Email Auth / Guest Mode: آماده
- History + Credit read services: آماده
- Supabase migrations + RLS: آماده
- Migration CI: فعال
- Worker rate limiting + observability: آماده
- Auth token verification: آماده
- Server-side credit charging/refunds: آماده
- Persistent authenticated conversations: آماده
- Git-driven Supabase production workflow: آماده
- Cloudflare Git deployment config: آماده اتصال
- Payment / Admin / بازکردن کامل گفتگوهای قدیمی از History / Streaming: مرحله بعد
