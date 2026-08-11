export type AiMarkdownDocument = {
  name: string;
  blob: Blob;
};

export type AiMarkdownResult = {
  id?: string;
  name?: string;
  format?: 'markdown' | 'text' | 'error';
  mimetype?: string;
  mimeType?: string;
  tokens?: number;
  data?: string;
  error?: string;
};

export type AiBinding = {
  run(model: string, input: Record<string, unknown>): Promise<any>;
  toMarkdown?(
    input: AiMarkdownDocument | AiMarkdownDocument[],
    options?: Record<string, unknown>,
  ): Promise<AiMarkdownResult | AiMarkdownResult[]>;
};

export type RateLimitBinding = {
  limit(input: { key: string }): Promise<{ success: boolean }>;
};

export type DurableObjectStubBinding = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export type DurableObjectNamespaceBinding = {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubBinding;
};

export type Env = {
  AI: AiBinding;
  API_RATE_LIMITER: RateLimitBinding;
  IMAGE_RATE_LIMITER: RateLimitBinding;
  GUEST_QUOTA?: DurableObjectNamespaceBinding;
  ALLOWED_ORIGIN?: string;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  GEMINI_API_KEY?: string;
  NANO_BANANA_MODEL?: string;
};

export type ConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type AiAttachment = {
  name: string;
  mimeType: string;
  dataUrl: string;
  size?: number;
};

export type AiRequest = {
  mode: 'chat' | 'image';
  message: string;
  history?: ConversationMessage[];
  conversationId?: string;
  attachments?: AiAttachment[];
  imageAction?: 'generate' | 'edit';
  referenceImage?: string;
  referencePrompt?: string;
  replyToMessageId?: string;
};
