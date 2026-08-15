import { handleImageRuntimeDiagnostic } from './image-runtime';
import type { Env } from '../types';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'farsiai-image-runtime-diagnostic', version: 'v063' });
    }
    return handleImageRuntimeDiagnostic(request, env);
  },
};
