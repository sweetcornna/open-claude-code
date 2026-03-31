// Type declarations for custom Ink JSX elements
declare global {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': any;
      'ink-text': any;
      'ink-link': any;
      'ink-raw-ansi': any;
    }
  }
}

export {};
