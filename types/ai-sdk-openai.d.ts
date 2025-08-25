declare module "@ai-sdk/openai" {
  // Minimal type shim to satisfy TypeScript; real types come from the package
  export function createOpenAI(options: {
    apiKey: string;
  }): (model: string) => any;
}
