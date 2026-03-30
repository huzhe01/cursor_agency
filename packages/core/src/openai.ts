import OpenAI from 'openai';
import type { AgencyConfig } from './config.js';
import { parseJsonOutput } from './json.js';

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  rawMessage: Record<string, unknown>;
}

function normalizeMessageContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
          return item.text;
        }
        return '';
      })
      .join('\n')
      .trim();
  }

  return '';
}

export class OpenAIModelAdapter {
  private readonly client?: OpenAI;
  private readonly model: string;
  private readonly embedModel: string;

  constructor(
    config: AgencyConfig,
    overrides: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      embedModel?: string;
    } = {},
  ) {
    this.model = overrides.model ?? config.openaiModel;
    this.embedModel = overrides.embedModel ?? config.openaiEmbedModel;
    const apiKey = overrides.apiKey ?? config.openaiApiKey;
    const baseURL = overrides.baseUrl ?? config.openaiBaseUrl;
    if (apiKey) {
      this.client = new OpenAI({
        apiKey,
        baseURL,
      });
    }
  }

  get ready(): boolean {
    return Boolean(this.client);
  }

  async generateText(systemPrompt: string, userPrompt: string, options: { model?: string; temperature?: number } = {}): Promise<string> {
    if (!this.client) {
      throw new Error('OPENAI_API_KEY is not configured.');
    }

    const response = await this.client.chat.completions.create({
      model: options.model ?? this.model,
      temperature: options.temperature ?? 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    return normalizeMessageContent(response.choices[0]?.message?.content).trim();
  }

  async generateJson<T>(systemPrompt: string, userPrompt: string, options: { model?: string; temperature?: number } = {}): Promise<T> {
    const response = await this.generateText(systemPrompt, userPrompt, options);
    return parseJsonOutput<T>(response);
  }

  async completeWithTools(messages: Array<Record<string, unknown>>, tools: Array<Record<string, unknown>>): Promise<ModelTurn> {
    if (!this.client) {
      throw new Error('OPENAI_API_KEY is not configured.');
    }

    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0.1,
      messages: messages as never,
      tools: tools as never,
      tool_choice: 'auto',
    });

    const message = response.choices[0]?.message as unknown as Record<string, unknown> | undefined;
    const toolCallsRaw = Array.isArray(message?.tool_calls) ? message.tool_calls as Array<Record<string, unknown>> : [];

    const toolCalls: ToolCall[] = toolCallsRaw.map((toolCall) => {
      const fn = toolCall.function as Record<string, unknown>;
      const rawArgs = typeof fn.arguments === 'string' ? fn.arguments : '{}';
      return {
        id: String(toolCall.id),
        name: String(fn.name),
        args: JSON.parse(rawArgs),
      };
    });

    return {
      text: normalizeMessageContent(message?.content).trim(),
      toolCalls,
      rawMessage: message ?? {},
    };
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (!this.client) {
      throw new Error('OPENAI_API_KEY is not configured.');
    }

    const response = await this.client.embeddings.create({
      model: this.embedModel,
      input: texts,
    });

    return response.data.map((item) => item.embedding);
  }
}
