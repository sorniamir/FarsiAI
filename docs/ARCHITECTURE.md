# Architecture

## اصول

- API keys هرگز داخل اپ موبایل قرار نمی‌گیرند.
- تمام درخواست‌های AI از Cloudflare Worker عبور می‌کنند.
- UI و برند از فایل Theme مرکزی کنترل می‌شوند.
- مدل‌ها پشت یک Gateway قرار دارند تا بعداً بدون بازنویسی اپ قابل تعویض باشند.

## MVP

```text
Expo Mobile
    |
    v
Cloudflare Worker
    |
    +--> Language detection
    +--> M2M100 translation (fa <-> en)
    +--> Qwen3 chat
    +--> FLUX.1 Schnell image
```

## Phase 2

- Auth
- User profile
- Conversation history
- Credit ledger
- Subscription plans
- Admin dashboard
- Rate limiting per user/device

## Phase 3

- Video generation provider abstraction
- Voice input/output
- Model router (fast / smart / creative)
- Memory and user preferences
