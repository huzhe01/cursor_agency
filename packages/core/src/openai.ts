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

export interface TextStreamHandlers {
  onTextDelta?(delta: string): Promise<void> | void;
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

function normalizeDeltaContent(content: unknown): string {
  return normalizeMessageContent(content);
}

function parseToolArgs(rawArgs: string): Record<string, unknown> {
  try {
    return JSON.parse(rawArgs);
  } catch {
    return { _raw: rawArgs };
  }
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

  async generateText(
    systemPrompt: string,
    userPrompt: string,
    options: { model?: string; temperature?: number } = {},
    handlers: TextStreamHandlers = {},
  ): Promise<string> {
    if (!this.client) {
      throw new Error('OPENAI_API_KEY is not configured.');
    }

    if (!handlers.onTextDelta) {
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

    let streamedText = '';
    let emittedAnyDelta = false;
    try {
      const stream = await this.client.chat.completions.create({
        model: options.model ?? this.model,
        temperature: options.temperature ?? 0.2,
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });

      for await (const chunk of stream as AsyncIterable<Record<string, unknown>>) {
        const choices = Array.isArray(chunk.choices) ? chunk.choices as Array<Record<string, unknown>> : [];
        const choice = choices[0] ?? {};
        const delta = (choice.delta as Record<string, unknown> | undefined) ?? {};
        const content = normalizeDeltaContent(delta.content);
        if (!content) {
          continue;
        }
        emittedAnyDelta = true;
        streamedText += content;
        await handlers.onTextDelta(content);
      }

      return streamedText.trim();
    } catch (error) {
      if (emittedAnyDelta) {
        throw error;
      }
      const fallback = await this.client.chat.completions.create({
        model: options.model ?? this.model,
        temperature: options.temperature ?? 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });
      const content = normalizeMessageContent(fallback.choices[0]?.message?.content).trim();
      if (content) {
        await handlers.onTextDelta(content);
      }
      return content;
    }
  }

  async generateJson<T>(systemPrompt: string, userPrompt: string, options: { model?: string; temperature?: number } = {}): Promise<T> {
    const response = await this.generateText(systemPrompt, userPrompt, options);
    return parseJsonOutput<T>(response);
  }

  async completeWithTools(
    messages: Array<Record<string, unknown>>,
    tools: Array<Record<string, unknown>>,
    handlers: TextStreamHandlers = {},
  ): Promise<ModelTurn> {
    if (!this.client) {
      throw new Error('OPENAI_API_KEY is not configured.');
    }

    if (!handlers.onTextDelta) {
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
          args: parseToolArgs(rawArgs),
        };
      });

      return {
        text: normalizeMessageContent(message?.content).trim(),
        toolCalls,
        rawMessage: message ?? {},
      };
    }

    let emittedAnyDelta = false;
    let text = '';
    const toolCallParts = new Map<number, { id: string; name: string; rawArgs: string }>();

    try {
      const stream = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0.1,
        messages: messages as never,
        tools: tools as never,
        tool_choice: 'auto',
        stream: true,
      });

      for await (const chunk of stream as AsyncIterable<Record<string, unknown>>) {
        const choices = Array.isArray(chunk.choices) ? chunk.choices as Array<Record<string, unknown>> : [];
        const choice = choices[0] ?? {};
        const delta = (choice.delta as Record<string, unknown> | undefined) ?? {};

        const content = normalizeDeltaContent(delta.content);
        if (content) {
          emittedAnyDelta = true;
          text += content;
          await handlers.onTextDelta(content);
        }

        const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls as Array<Record<string, unknown>> : [];
        for (const partial of toolCalls) {
          const index = typeof partial.index === 'number' ? partial.index : toolCallParts.size;
          const existing = toolCallParts.get(index) ?? { id: '', name: '', rawArgs: '' };
          if (typeof partial.id === 'string') {
            existing.id = partial.id;
          }
          const fn = (partial.function as Record<string, unknown> | undefined) ?? {};
          if (typeof fn.name === 'string') {
            existing.name = fn.name;
          }
          if (typeof fn.arguments === 'string') {
            existing.rawArgs += fn.arguments;
          }
          toolCallParts.set(index, existing);
        }
      }
    } catch (error) {
      if (emittedAnyDelta) {
        throw error;
      }
      return this.completeWithTools(messages, tools);
    }

    const toolCalls: ToolCall[] = [...toolCallParts.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, toolCall], index) => ({
        id: toolCall.id || `toolcall-${index + 1}`,
        name: toolCall.name,
        args: parseToolArgs(toolCall.rawArgs || '{}'),
      }))
      .filter((toolCall) => toolCall.name);

    return {
      text: text.trim(),
      toolCalls,
      rawMessage: {
        role: 'assistant',
        content: text,
        tool_calls: toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: 'function',
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.args),
          },
        })),
      },
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
