export type AppMode = 'chat' | 'image' | 'video';

export type DailyQuota = {
  chatRemaining: number;
  imageRemaining: number;
  unlimited?: boolean;
};

export type UiAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  previewUri?: string;
};

export type UiMessage = {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  image?: string;
  revisedPrompt?: string;
  attachments?: UiAttachment[];
  replyToId?: string;
};
