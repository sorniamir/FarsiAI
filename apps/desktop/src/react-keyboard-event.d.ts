import 'react';

declare module 'react' {
  interface KeyboardEvent<T = Element> {
    readonly isComposing: boolean;
  }
}
