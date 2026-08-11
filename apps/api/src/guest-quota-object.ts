import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';

type GuestMode = 'chat' | 'image';

type GuestQuotaState = {
  day: string;
  chatUsed: number;
  imageUsed: number;
  events: Record<string, { mode: GuestMode; refunded: boolean }>;
};

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function nextUtcReset(day: string): string {
  const current = new Date(`${day}T00:00:00.000Z`).getTime();
  return new Date(current + 86_400_000).toISOString();
}

function freshState(day = utcDay()): GuestQuotaState {
  return { day, chatUsed: 0, imageUsed: 0, events: {} };
}

function quota(state: GuestQuotaState) {
  return {
    chatRemaining: Math.max(0, 5 - state.chatUsed),
    imageRemaining: Math.max(0, 2 - state.imageUsed),
    resetsAt: nextUtcReset(state.day),
  };
}

export class GuestQuotaDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private async readState(): Promise<GuestQuotaState> {
    const day = utcDay();
    const stored = await this.ctx.storage.get<GuestQuotaState>('quota');
    if (!stored || stored.day !== day) {
      const next = freshState(day);
      await this.ctx.storage.put('quota', next);
      return next;
    }
    return stored;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ ok: false, error: 'method_not_allowed' }, { status: 405 });
    }

    const url = new URL(request.url);
    let payload: Record<string, unknown>;
    try {
      payload = await request.json() as Record<string, unknown>;
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }

    const referenceId = String(payload.referenceId ?? '').trim();
    if (!referenceId) {
      return Response.json({ ok: false, error: 'reference_required' }, { status: 400 });
    }

    const state = await this.readState();

    if (url.pathname === '/spend') {
      const mode = payload.mode === 'image' ? 'image' : payload.mode === 'chat' ? 'chat' : undefined;
      if (!mode) {
        return Response.json({ ok: false, error: 'invalid_mode' }, { status: 400 });
      }

      const existing = state.events[referenceId];
      if (existing && !existing.refunded) {
        return Response.json({ ok: true, quota: quota(state) });
      }

      if (mode === 'chat' && state.chatUsed >= 5) {
        return Response.json({ ok: false, reason: 'chat_limit', quota: quota(state) }, { status: 402 });
      }
      if (mode === 'image' && state.imageUsed >= 2) {
        return Response.json({ ok: false, reason: 'image_limit', quota: quota(state) }, { status: 402 });
      }

      if (mode === 'chat') state.chatUsed += 1;
      else state.imageUsed += 1;
      state.events[referenceId] = { mode, refunded: false };
      await this.ctx.storage.put('quota', state);
      return Response.json({ ok: true, quota: quota(state) });
    }

    if (url.pathname === '/refund') {
      const event = state.events[referenceId];
      if (event && !event.refunded) {
        if (event.mode === 'chat') state.chatUsed = Math.max(0, state.chatUsed - 1);
        else state.imageUsed = Math.max(0, state.imageUsed - 1);
        event.refunded = true;
        await this.ctx.storage.put('quota', state);
      }
      return Response.json({ ok: true, quota: quota(state) });
    }

    return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
  }
}
