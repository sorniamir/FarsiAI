# FarsiAI — MVP 0.1

اپ هوش مصنوعی فارسی با چت، ساخت تصویر داخل همان گفتگو و بخش ویدیو (Coming Soon).

## ساختار

- `apps/mobile`: React Native + Expo
- `apps/api`: Cloudflare Worker + Workers AI
- `docs`: معماری و Roadmap

## AI Flow

- Chat: Persian input → M2M100 → Qwen3 → M2M100 → Persian output
- Image: Persian prompt → M2M100 → FLUX.1 Schnell → image
- API keys فقط در Backend نگهداری می‌شوند.

## اجرای محلی

```bash
npm install
npm run check
```

API:
```bash
cd apps/api
npx wrangler dev
```

Mobile:
```bash
cd apps/mobile
EXPO_PUBLIC_API_URL=http://YOUR-LAN-IP:8787 npx expo start
```

## وضعیت

- Chat UI: آماده
- Image Mode: آماده
- Video: Coming Soon
- Auth / Subscription / Payment: فاز بعدی
