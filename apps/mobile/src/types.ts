export type AppMode = 'chat' | 'image' | 'video';

export type UiMessage = {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  image?: string;
};
