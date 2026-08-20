import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

export function getAnthropicClient(apiKey: string): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey });
  }
  return client;
}
