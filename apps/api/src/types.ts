export type AiBinding = {
  run(model: string, input: Record<string, unknown>): Promise<any>;
};

export type Env = {
  AI: AiBinding;
  ALLOWED_ORIGIN?: string;
};

export type ConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type AiRequest = {
  mode: 'chat' | 'image';
  message: string;
  history?: ConversationMessage[];
};
