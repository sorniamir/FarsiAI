export type AppMode = 'chat' | 'image' | 'video';

export type DailyQuota = {
  chatRemaining: number;
  imageRemaining: number;
};

export type UiMessage = {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  image?: string;
  revisedPrompt?: string;
};
