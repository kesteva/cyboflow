declare module 'ansi-to-html' {
  interface AnsiToHtmlOptions {
    fg?: string;
    bg?: string;
    newline?: boolean;
    escapeXML?: boolean;
    stream?: boolean;
    colors?: {
      [key: number]: string;
    };
  }

  class AnsiToHtml {
    constructor(options?: AnsiToHtmlOptions);
    toHtml(text: string): string;
  }

  export = AnsiToHtml;
}