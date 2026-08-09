export type AiBinding = {
  run(model: string, input: Record<string, unknown>): Promise<any>;
};

export type RateLimitBinding = {
  limit(input: { key: string }): Promise<{ success: boolean }>;
};

export type Env = {
  AI: AiBinding;
  API_RATE_LIMITER: RateLimitBinding;
  IMAGE_RATE_LIMITER: RateLimitBinding;
  ALLOWED_ORIGIN?: string;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

export type ConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type AiRequest = {
  mode: 'chat' | 'image';
  message: string;
  history?: ConversationMessage[];
  conversationId?: string;
};
