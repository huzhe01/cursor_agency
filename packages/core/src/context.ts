import type { SessionStore } from './session-store.js';

export interface TokenEstimator {
  estimateText(text: string): number;
  estimateMessage(message: Record<string, unknown>): number;
  estimateMessages(messages: Array<Record<string, unknown>>): number;
}

export interface ContextBudgetSnapshot {
  totalTokens: number;
  allowedInputTokens: number;
  reserveForResponse: number;
  toolOutputBudget: number;
  compressed: boolean;
  usedRollingSummary: boolean;
  summarizedMessages: number;
  droppedMessages: number;
  artifactReferences: string[];
  summaryArtifactPath?: string;
}

interface ContextState {
  rollingSummary: string;
  archivedUntilIndex: number;
  summaryArtifactPath?: string;
}

export interface PreparedContext {
  messages: Array<Record<string, unknown>>;
  snapshot: ContextBudgetSnapshot;
}

export class ApproxTokenEstimator implements TokenEstimator {
  estimateText(text: string): number {
    return Math.ceil(text.length / 4) + 1;
  }

  estimateMessage(message: Record<string, unknown>): number {
    const role = typeof message.role === 'string' ? message.role : 'unknown';
    const content = extractMessageText(message);
    const toolCalls = Array.isArray(message.tool_calls) ? JSON.stringify(message.tool_calls) : '';
    return this.estimateText(`${role}\n${content}\n${toolCalls}`) + 6;
  }

  estimateMessages(messages: Array<Record<string, unknown>>): number {
    return messages.reduce((total, message) => total + this.estimateMessage(message), 0);
  }
}

export interface ContextManagerConfig {
  contextTokenBudget: number;
  reserveForResponse: number;
  toolOutputBudget: number;
  summaryTriggerRatio: number;
}

export interface ContextPreparationOptions {
  round: number;
  phase: 'plan' | 'execute' | 'verify';
  artifactReferences: string[];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const head = value.slice(0, Math.max(400, Math.floor(maxChars * 0.7)));
  const tail = value.slice(-Math.max(160, Math.floor(maxChars * 0.15)));
  return `${head}\n\n[truncated]\n\n${tail}`;
}

function summarizeMessage(message: Record<string, unknown>): string {
  const role = typeof message.role === 'string' ? message.role : 'unknown';
  const content = extractMessageText(message).replace(/\s+/g, ' ').trim();
  const normalized = content.length > 220 ? `${content.slice(0, 220)}…` : content;
  if (!normalized) {
    return `- ${role}: (empty)`;
  }
  return `- ${role}: ${normalized}`;
}

function buildSummary(previousSummary: string, newMessages: Array<Record<string, unknown>>): string {
  const additions = newMessages
    .filter((message) => typeof message.role === 'string' && message.role !== 'system')
    .map(summarizeMessage)
    .join('\n');

  const merged = [previousSummary.trim(), additions.trim()].filter(Boolean).join('\n');
  return truncateText(merged, 6000);
}

export function extractMessageText(message: Record<string, unknown>): string {
  const content = message.content;
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

export class ContextManager {
  private readonly states = new Map<string, ContextState>();
  private readonly estimator: TokenEstimator;
  private readonly config: ContextManagerConfig;

  constructor(config: ContextManagerConfig, estimator: TokenEstimator = new ApproxTokenEstimator()) {
    this.config = config;
    this.estimator = estimator;
  }

  async prepareMessages(
    session: SessionStore,
    messages: Array<Record<string, unknown>>,
    options: ContextPreparationOptions,
  ): Promise<PreparedContext> {
    const state = this.states.get(session.id) ?? {
      rollingSummary: '',
      archivedUntilIndex: 1,
    };
    this.states.set(session.id, state);

    const allowedInputTokens = Math.max(512, this.config.contextTokenBudget - this.config.reserveForResponse);
    const totalTokens = this.estimator.estimateMessages(messages);
    const snapshot: ContextBudgetSnapshot = {
      totalTokens,
      allowedInputTokens,
      reserveForResponse: this.config.reserveForResponse,
      toolOutputBudget: this.config.toolOutputBudget,
      compressed: false,
      usedRollingSummary: false,
      summarizedMessages: Math.max(0, state.archivedUntilIndex - 1),
      droppedMessages: 0,
      artifactReferences: options.artifactReferences.slice(-12),
      summaryArtifactPath: state.summaryArtifactPath,
    };

    if (messages.length <= 1 || totalTokens <= allowedInputTokens * this.config.summaryTriggerRatio) {
      return { messages, snapshot };
    }

    const protectedSystemMessages = messages.filter((message) => message.role === 'system');
    const minimumTailCount = 4;
    const targetTailTokens = Math.floor(allowedInputTokens * 0.55);
    let tailStart = messages.length;
    let tailTokens = 0;
    while (tailStart > protectedSystemMessages.length) {
      const nextIndex = tailStart - 1;
      const nextTokens = this.estimator.estimateMessage(messages[nextIndex]!);
      if (tailTokens >= targetTailTokens && messages.length - tailStart >= minimumTailCount) {
        break;
      }
      tailStart = nextIndex;
      tailTokens += nextTokens;
    }

    const archiveEnd = Math.max(protectedSystemMessages.length, tailStart);
    if (archiveEnd > state.archivedUntilIndex) {
      const archivedMessages = messages.slice(state.archivedUntilIndex, archiveEnd);
      state.rollingSummary = buildSummary(state.rollingSummary, archivedMessages);
      state.archivedUntilIndex = archiveEnd;
      state.summaryArtifactPath = await session.writeArtifact(
        `context-summary-round-${options.round}.md`,
        `# Rolling Summary\n\n${state.rollingSummary}\n`,
      );
    }

    let preparedMessages = [
      ...protectedSystemMessages,
      ...(state.rollingSummary
        ? [{
            role: 'system',
            content: `Conversation summary from earlier turns:\n${truncateText(state.rollingSummary, 2400)}`,
          }]
        : []),
      ...messages.slice(state.archivedUntilIndex),
    ];

    let preparedTokens = this.estimator.estimateMessages(preparedMessages);
    let droppedMessages = 0;
    while (preparedMessages.length > protectedSystemMessages.length + 1 && preparedTokens > allowedInputTokens) {
      preparedMessages.splice(protectedSystemMessages.length + 1, 1);
      droppedMessages += 1;
      preparedTokens = this.estimator.estimateMessages(preparedMessages);
    }

    snapshot.compressed = true;
    snapshot.usedRollingSummary = Boolean(state.rollingSummary);
    snapshot.summarizedMessages = Math.max(0, state.archivedUntilIndex - 1);
    snapshot.droppedMessages = droppedMessages;
    snapshot.summaryArtifactPath = state.summaryArtifactPath;

    return {
      messages: preparedMessages,
      snapshot,
    };
  }

  trimText(value: string, maxTokens: number): string {
    const tokenLimit = clamp(maxTokens, 64, this.config.contextTokenBudget);
    if (this.estimator.estimateText(value) <= tokenLimit) {
      return value;
    }

    return truncateText(value, tokenLimit * 4);
  }
}
