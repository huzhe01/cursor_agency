import type { AgencyConfig } from './config.js';
import { relativeToRoot } from './config.js';
import { SessionStore } from './session-store.js';
import { OpenAIModelAdapter } from './openai.js';
import { SQLiteIndexProvider, type SearchResult } from '@agency/indexer';
import { createDefaultTools, type ApprovalKind, type ToolContext, type ToolDefinition } from '@agency/tools';

export interface ApprovalRequest {
  sessionId: string;
  toolName: string;
  approval: ApprovalKind;
  args: Record<string, unknown>;
}

export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>;

export interface RuntimeCallbacks {
  onPlan?(plan: string, planPath: string): Promise<void> | void;
  onInfo?(message: string): Promise<void> | void;
  onFinal?(message: string): Promise<void> | void;
}

export interface TaskOutcome {
  sessionId: string;
  plan: string;
  finalMessage: string;
  verification: string;
  diff: string;
}

export interface ConversationHandle {
  session: SessionStore;
  prompt(input: string): Promise<TaskOutcome>;
}

interface ConversationState {
  mode: 'task' | 'chat';
  session: SessionStore;
  messages: Array<Record<string, unknown>>;
}

const PLAN_PROMPT = `You are planning a coding task inside a repository. Produce concise Markdown with these headings: Goal, Context, Steps, Verification. Mention likely files. Prefer a short, execution-ready plan.`;
const EXECUTION_PROMPT = `You are a pragmatic code agent working in a real repository.

Follow this loop:
1. Gather context with list_files, search_index, search_code, read_file, or read_multiple_files.
2. Decide on one narrow change at a time.
3. Prefer apply_unified_patch for precise edits. Use write_patch only for simple replacements or full-file creation.
4. Verify after changes. Always call read_diff before your final answer when files changed.

Rules:
- Do not call write tools before inspecting the relevant file contents.
- Keep shell commands bounded and diagnostic.
- If the task can be answered without changing files, do not edit.
- If a write or shell tool is denied, continue with read-only analysis.
- Keep final answers concise and concrete.`;

function formatHits(hits: SearchResult[]): string {
  if (hits.length === 0) {
    return 'No index hits were found.';
  }

  return hits
    .map((hit, index) => `${index + 1}. ${hit.path}:${hit.startLine}-${hit.endLine} [${hit.source}] score=${hit.score.toFixed(3)}\n${hit.excerpt}`)
    .join('\n\n');
}

function toToolSpecs(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function buildExecutionUserPrompt(prompt: string, plan: string, hits: SearchResult[]): string {
  return [
    `Task:\n${prompt}`,
    `Plan:\n${plan}`,
    `Indexed context:\n${formatHits(hits)}`,
    'Working style:',
    '- Inspect before editing.',
    '- Use apply_unified_patch for exact code changes.',
    '- Keep edits minimal and local.',
    '- Verify with read_diff before finishing if any file changed.',
  ].join('\n\n');
}

async function maybeApprove(request: ApprovalRequest, approvalHandler: ApprovalHandler, autoApprove: boolean): Promise<boolean> {
  if (request.approval === 'read' || autoApprove) {
    return true;
  }

  return approvalHandler(request);
}

export class AgencyRuntime {
  private readonly config: AgencyConfig;
  private readonly model: OpenAIModelAdapter;
  private readonly index: SQLiteIndexProvider;
  private readonly approvalHandler: ApprovalHandler;
  private readonly callbacks: RuntimeCallbacks;

  constructor(config: AgencyConfig, approvalHandler: ApprovalHandler, callbacks: RuntimeCallbacks = {}) {
    this.config = config;
    this.model = new OpenAIModelAdapter(config);
    this.index = new SQLiteIndexProvider({
      rootDir: config.rootDir,
      dbPath: config.indexPath,
      embedder: this.model.ready ? this.model : undefined,
    });
    this.approvalHandler = approvalHandler;
    this.callbacks = callbacks;
  }

  async buildIndex(): Promise<ReturnType<SQLiteIndexProvider['build']>> {
    return this.index.build();
  }

  async watchIndex(): Promise<void> {
    await this.index.watch((stats) => {
      void this.callbacks.onInfo?.(`Reindexed ${stats.indexedFiles} files, removed ${stats.deletedFiles}.`);
    });
  }

  async runTask(prompt: string, mode: 'task' | 'chat' = 'task', existingSession?: SessionStore): Promise<TaskOutcome> {
    const conversation = existingSession
      ? this.createConversationState(existingSession, mode)
      : await this.createConversation(mode);
    return this.runConversationTurn(conversation, prompt);
  }

  async createSession(mode: 'task' | 'chat'): Promise<SessionStore> {
    const session = await SessionStore.create(this.config.rootDir, this.config.sessionDir, mode);
    await session.appendEvent('session_started', { mode });
    return session;
  }

  async createChatSession(): Promise<ConversationHandle> {
    const conversation = await this.createConversation('chat');
    return {
      session: conversation.session,
      prompt: async (input: string) => this.runConversationTurn(conversation, input),
    };
  }

  private createConversationState(session: SessionStore, mode: 'task' | 'chat'): ConversationState {
    return {
      mode,
      session,
      messages: [{ role: 'system', content: EXECUTION_PROMPT }],
    };
  }

  private async createConversation(mode: 'task' | 'chat'): Promise<ConversationState> {
    const session = await this.createSession(mode);
    return this.createConversationState(session, mode);
  }

  private async runConversationTurn(conversation: ConversationState, prompt: string): Promise<TaskOutcome> {
    if (!this.model.ready) {
      throw new Error('OPENAI_API_KEY is required for task and chat commands.');
    }

    const session = conversation.session;
    const hits = await this.index.search(prompt, 6).catch(() => []);
    const plan = await this.model.generateText(
      PLAN_PROMPT,
      `Task:\n${prompt}\n\nIndexed context:\n${formatHits(hits)}`,
    );
    await session.writePlan(plan);
    await session.appendEvent('user_prompt', { prompt, mode: conversation.mode });
    await this.callbacks.onPlan?.(plan, relativeToRoot(this.config, session.planPath));

    const tools = createDefaultTools();
    const toolContext: ToolContext = {
      rootDir: this.config.rootDir,
      session,
      index: this.index,
    };

    conversation.messages.push({
      role: 'user',
      content: buildExecutionUserPrompt(prompt, plan, hits),
    });

    const toolSpecs = toToolSpecs(tools);
    let finalMessage = '';

    for (let step = 0; step < this.config.maxToolSteps; step += 1) {
      const turn = await this.model.completeWithTools(conversation.messages, toolSpecs);
      conversation.messages.push(turn.rawMessage);
      if (turn.text) {
        await session.appendEvent('assistant_message', { step, content: turn.text });
      }

      if (turn.toolCalls.length === 0) {
        finalMessage = turn.text || 'Task completed without additional output.';
        break;
      }

      for (const toolCall of turn.toolCalls) {
        const tool = tools.find((candidate) => candidate.name === toolCall.name);
        if (!tool) {
          const errorMessage = `Tool ${toolCall.name} is not registered.`;
          conversation.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: errorMessage });
          await session.appendEvent('tool_error', { tool: toolCall.name, error: errorMessage });
          continue;
        }

        const approved = await maybeApprove(
          { sessionId: session.id, toolName: tool.name, approval: tool.approval, args: toolCall.args },
          this.approvalHandler,
          this.config.autoApprove,
        );

        if (!approved) {
          const denied = `Tool ${tool.name} was denied by the user.`;
          conversation.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: denied });
          await session.appendEvent('tool_denied', { tool: tool.name, args: toolCall.args });
          continue;
        }

        try {
          const result = await tool.execute(toolCall.args, toolContext);
          conversation.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result.content });
          await session.appendEvent('tool_result', {
            tool: tool.name,
            args: toolCall.args,
            artifactPath: result.artifactPath,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          conversation.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: `Tool error: ${message}` });
          await session.appendEvent('tool_error', { tool: tool.name, args: toolCall.args, error: message });
        }
      }
    }

    if (!finalMessage) {
      finalMessage = 'Reached the tool step limit before the model produced a final answer.';
    }

    const diff = await session.renderDiff();
    if (diff) {
      await session.writeArtifact('workspace-diff.patch', diff);
    }
    const verification = diff
      ? await this.model.generateText(
          'You are verifying the result of a coding task. Summarize the observed diff, call out risks, and say whether the task looks complete.',
          `Task:\n${prompt}\n\nPlan:\n${plan}\n\nDiff:\n${diff}`,
        )
      : 'No file changes were made during this session.';

    await session.appendEvent('final', { finalMessage, verification });
    await this.callbacks.onFinal?.(finalMessage);

    return {
      sessionId: session.id,
      plan,
      finalMessage,
      verification,
      diff,
    };
  }

  close(): void {
    this.index.close();
  }
}
