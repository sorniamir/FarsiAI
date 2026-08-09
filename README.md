# FarsiAI — Product MVP 0.2

اپ هوش مصنوعی فارسی با چت، ساخت تصویر داخل همان گفتگو، حساب کاربری، تاریخچه، Credit Wallet و بخش ویدیو (Coming Soon).

## معماری

- `apps/mobile`: React Native + Expo 57
- `apps/api`: Cloudflare Worker + Workers AI
- `supabase/schema.sql`: Auth data model, conversations, messages, credit wallet/ledger + RLS
- `docs`: معماری و Roadmap

## AI Flow

- Chat: Persian input → M2M100 → Qwen3 → M2M100 → Persian output
- Image: Persian prompt → M2M100 → FLUX.1 Schnell → image
- API keys و کلیدهای privileged فقط در Backend نگهداری می‌شوند.

## Product Flow

`Onboarding → Login / Guest → Chat | History | Profile`

- Chat و Image Mode در یک محیط
- Video AI به‌صورت Coming Soon
- Guest Mode برای تست بدون Backend Auth
- Supabase Auth به‌صورت env-based
- Credit Wallet و Ledger برای محدودیت مصرف و اشتراک آینده

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

## اتصال Supabase

1. یک Supabase project ایجاد کن.
2. فایل `supabase/schema.sql` را در SQL Editor اجرا کن.
3. مقادیر زیر را در env موبایل قرار بده:

```env
EXPO_PUBLIC_SUPABASE_URL=...
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
```

`SUPABASE_SERVICE_ROLE_KEY` هرگز نباید وارد اپ موبایل یا Git شود؛ این کلید فقط برای Backend آینده است.

## وضعیت v0.2

- Persian Chat UI: آماده
- Image Mode: آماده
- Onboarding: آماده
- Email Auth shell: آماده
- Guest Mode: آماده
- History UI: آماده برای اتصال دیتابیس
- Profile / Credits UI: آماده
- Supabase schema + RLS: آماده
- CI برای API و Mobile TypeScript: فعال
- Social Login / Payment / Admin / persistent AI conversations: مرحله بعد
