import type { AgencyConfig } from './config.js';
import { relativeToRoot } from './config.js';
import { SessionStore } from './session-store.js';
import { OpenAIModelAdapter } from './openai.js';
import { SQLiteIndexProvider, type SearchResult } from '@agency/indexer';
import { createDefaultTools, type ApprovalKind, type ToolContext, type ToolDefinition } from '@agency/tools';
import { createBackendFactory } from './execution-backends.js';
import type { AcceptanceCheck, EvidenceBundle, EvidenceItem, VerifierResult, VerifierStatus } from './verifier.js';
import { ModelVerifier, RuleVerifier, verifyWithFallback } from './verifier.js';
import { ContextManager } from './context.js';
import type { RuntimeEvent, RuntimePhase } from './events.js';

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
  onEvent?(event: RuntimeEvent): Promise<void> | void;
}

export interface TaskOutcome {
  sessionId: string;
  status: VerifierStatus;
  rounds: number;
  backend: string;
  plan: string;
  finalMessage: string;
  verification: string;
  verifierResult: VerifierResult;
  diff: string;
  artifacts: string[];
}

export interface ConversationHandle {
  session: SessionStore;
  prompt(input: string): Promise<TaskOutcome>;
}

interface ConversationState {
  mode: 'task' | 'chat';
  session: SessionStore;
  messages: Array<Record<string, unknown>>;
  artifactReferences: string[];
}

interface RoundPlan {
  planMarkdown: string;
  acceptanceChecks: AcceptanceCheck[];
  requiredEvidence: string[];
  preferredBackend: 'default' | 'local' | 'e2b';
}

const EXECUTION_PROMPT = `You are a pragmatic code and data agent working in a real repository.

You must operate in explicit loops:
1. Gather context.
2. Execute one narrow round of work.
3. Produce evidence for the verifier.
4. Stop when the verifier passes or blocks the task.

Execution rules:
- Read before editing.
- Use paged file reads instead of loading giant files at once.
- Prefer replace_exact_text for narrow, exact edits.
- Prefer apply_unified_patch for structured edits or multi-region changes.
- Prefer run_python_script, run_duckdb_sql, inspect_table, and assert_table_checks for data work.
- Keep shell commands bounded and diagnostic.
- If a write or shell tool is denied, continue with read-only analysis and surface the blocker.
- When files change, call read_diff before finishing the round.
- Keep final answers concise and factual.`;

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

function defaultAcceptanceChecks(prompt: string): AcceptanceCheck[] {
  const normalized = prompt.toLowerCase();
  const checks: AcceptanceCheck[] = [];
  if (/(fix|update|change|implement|write|create|modify|patch|replace)/.test(normalized)) {
    checks.push({ type: 'diff_present', description: 'The task should produce a concrete workspace diff.' });
  } else {
    checks.push({ type: 'read_only_answer', description: 'The task should end with a concise read-only answer.' });
  }

  if (/(duckdb|sql|csv|parquet|python|data)/.test(normalized)) {
    checks.push({ type: 'python_exit_zero', description: 'Python execution must succeed for data-analysis work.' });
  }

  return checks;
}

function normalizeRoundPlan(value: Partial<RoundPlan> | undefined, prompt: string): RoundPlan {
  const normalizedChecks = Array.isArray(value?.acceptanceChecks)
    ? value.acceptanceChecks.filter((check): check is AcceptanceCheck => Boolean(check?.type && check?.description))
    : [];
  return {
    planMarkdown: typeof value?.planMarkdown === 'string' && value.planMarkdown.trim()
      ? value.planMarkdown.trim()
      : `# Goal\n${prompt}\n\n# Steps\n1. Inspect the relevant code or data.\n2. Perform one narrow execution round.\n3. Collect evidence and verify the result.`,
    acceptanceChecks: normalizedChecks.length > 0 ? normalizedChecks : defaultAcceptanceChecks(prompt),
    requiredEvidence: Array.isArray(value?.requiredEvidence)
      ? value.requiredEvidence.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : ['tool outputs', 'final reasoning'],
    preferredBackend: value?.preferredBackend === 'local' || value?.preferredBackend === 'e2b' ? value.preferredBackend : 'default',
  };
}

function buildRoundPlanningPrompt(prompt: string, indexedContext: string, previousVerifierText: string): string {
  return [
    `Task:\n${prompt}`,
    `Indexed context:\n${indexedContext}`,
    `Previous verifier result:\n${previousVerifierText}`,
    'Return strict JSON with keys planMarkdown, acceptanceChecks, requiredEvidence, preferredBackend.',
    'acceptanceChecks must use only these types: read_only_answer, diff_present, shell_exit_zero, python_exit_zero, duckdb_checks_pass, artifact_exists.',
    'preferredBackend must be one of default, local, e2b.',
  ].join('\n\n');
}

function buildRoundExecutionPrompt(prompt: string, roundPlan: RoundPlan, indexedContext: string, round: number, previousVerifierText: string): string {
  return [
    `Task:\n${prompt}`,
    `Round: ${round}`,
    `Plan:\n${roundPlan.planMarkdown}`,
    `Acceptance checks:\n${JSON.stringify(roundPlan.acceptanceChecks, null, 2)}`,
    `Required evidence:\n${roundPlan.requiredEvidence.join(', ')}`,
    `Indexed context:\n${indexedContext}`,
    `Previous verifier:\n${previousVerifierText}`,
    'Use replace_exact_text for narrow exact replacements, and apply_unified_patch only for structured edits.',
    'Gather evidence for the verifier. If you modify files, read the diff before you stop this round.',
  ].join('\n\n');
}

async function maybeApprove(request: ApprovalRequest, approvalHandler: ApprovalHandler, autoApprove: boolean): Promise<boolean> {
  if (request.approval === 'read' || autoApprove) {
    return true;
  }

  return approvalHandler(request);
}

function buildEvidenceFromTool(
  toolName: string,
  metadata: Record<string, unknown> | undefined,
  artifactPath: string | undefined,
): EvidenceItem[] {
  if (!metadata) {
    return artifactPath ? [{ kind: 'artifact', summary: `${toolName} produced ${artifactPath}`, artifactPath, passed: true }] : [];
  }

  if (toolName === 'run_shell') {
    const exitCode = typeof metadata.exitCode === 'number' ? metadata.exitCode : null;
    return [{
      kind: exitCode === 0 ? 'shell_success' : 'shell_failure',
      summary: `Shell command finished with exit=${exitCode ?? 'null'}.`,
      artifactPath,
      passed: exitCode === 0,
      metadata,
    }];
  }

  if (toolName === 'run_python_script') {
    const exitCode = typeof metadata.exitCode === 'number' ? metadata.exitCode : null;
    return [{
      kind: exitCode === 0 ? 'python_success' : 'python_failure',
      summary: `Python script finished with exit=${exitCode ?? 'null'}.`,
      artifactPath,
      passed: exitCode === 0,
      metadata,
    }];
  }

  if (toolName === 'assert_table_checks') {
    const passed = metadata.passed === true;
    return [{
      kind: passed ? 'duckdb_checks_pass' : 'duckdb_checks_fail',
      summary: passed ? 'DuckDB table checks passed.' : `DuckDB table checks failed: ${Array.isArray(metadata.failures) ? metadata.failures.join('; ') : 'unknown failure'}`,
      artifactPath,
      passed,
      metadata,
    }];
  }

  if (toolName === 'run_duckdb_sql') {
    return [{
      kind: 'duckdb_query',
      summary: `DuckDB query returned ${String(metadata.rowCount ?? '?')} row(s).`,
      artifactPath,
      passed: true,
      metadata,
    }];
  }

  if (toolName === 'inspect_table') {
    return [{
      kind: 'duckdb_inspection',
      summary: `Inspected table ${String(metadata.table ?? '?')} with ${String(metadata.rowCount ?? '?')} row(s).`,
      artifactPath,
      passed: true,
      metadata,
    }];
  }

  if (toolName === 'replace_exact_text') {
    return [{
      kind: 'file_edit',
      summary: `Exact replacement edited ${String(metadata.path ?? '?')} with ${String(metadata.replacedCount ?? '?')} replacement(s).`,
      artifactPath,
      passed: metadata.changed !== false,
      metadata,
    }];
  }

  if (toolName === 'apply_unified_patch' || toolName === 'write_patch') {
    return [{
      kind: 'file_edit',
      summary: `${toolName} updated file content.`,
      artifactPath,
      passed: true,
      metadata,
    }];
  }

  return artifactPath ? [{ kind: 'artifact', summary: `${toolName} produced ${artifactPath}`, artifactPath, passed: true, metadata }] : [];
}

export class AgencyRuntime {
  private readonly config: AgencyConfig;
  private readonly actorModel: OpenAIModelAdapter;
  private readonly verifierModel: OpenAIModelAdapter;
  private readonly index: SQLiteIndexProvider;
  private readonly approvalHandler: ApprovalHandler;
  private readonly callbacks: RuntimeCallbacks;
  private readonly backendFactory;
  private readonly ruleVerifier: RuleVerifier;
  private readonly modelVerifier: ModelVerifier;
  private readonly contextManager: ContextManager;

  constructor(config: AgencyConfig, approvalHandler: ApprovalHandler, callbacks: RuntimeCallbacks = {}) {
    this.config = config;
    this.actorModel = new OpenAIModelAdapter(config);
    this.verifierModel = new OpenAIModelAdapter(config, {
      apiKey: config.verifierApiKey,
      baseUrl: config.verifierBaseUrl,
      model: config.verifierModel,
      embedModel: config.openaiEmbedModel,
    });
    this.index = new SQLiteIndexProvider({
      rootDir: config.rootDir,
      dbPath: config.indexPath,
      embedder: this.actorModel.ready ? this.actorModel : undefined,
    });
    this.approvalHandler = approvalHandler;
    this.callbacks = callbacks;
    this.backendFactory = createBackendFactory({
      rootDir: config.rootDir,
      cacheDir: config.cacheDir,
      defaultBackend: config.defaultBackend,
      e2bApiKey: config.e2bApiKey,
      e2bTemplateId: config.e2bTemplateId,
    });
    this.ruleVerifier = new RuleVerifier();
    this.modelVerifier = new ModelVerifier(this.verifierModel);
    this.contextManager = new ContextManager({
      contextTokenBudget: config.contextTokenBudget,
      reserveForResponse: config.contextReserveTokens,
      toolOutputBudget: config.toolOutputCharLimit,
      summaryTriggerRatio: config.summaryTriggerRatio,
    });
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

  private async emitEvent(
    conversation: ConversationState,
    type: RuntimeEvent['type'],
    partial: Omit<RuntimeEvent, 'id' | 'timestamp' | 'sessionId' | 'mode' | 'type'> = {},
  ): Promise<void> {
    await this.callbacks.onEvent?.({
      sessionId: conversation.session.id,
      mode: conversation.mode,
      type,
      ...partial,
      id: '',
      timestamp: '',
    } as RuntimeEvent);
  }

  private async emitPhase(conversation: ConversationState, type: 'phase_started' | 'phase_completed', phase: RuntimePhase, round: number, data: Record<string, unknown> = {}): Promise<void> {
    await this.emitEvent(conversation, type, { phase, round, data });
    await conversation.session.appendEvent(type, { phase, round, ...data });
  }

  private createConversationState(session: SessionStore, mode: 'task' | 'chat'): ConversationState {
    return {
      mode,
      session,
      messages: [{ role: 'system', content: EXECUTION_PROMPT }],
      artifactReferences: [],
    };
  }

  private async createConversation(mode: 'task' | 'chat'): Promise<ConversationState> {
    const session = await this.createSession(mode);
    return this.createConversationState(session, mode);
  }

  private async planRound(conversation: ConversationState, prompt: string, hits: SearchResult[], round: number, previousVerifier?: VerifierResult): Promise<RoundPlan> {
    const indexedContext = this.contextManager.trimText(formatHits(hits), Math.floor(this.config.contextTokenBudget * 0.25));
    const previousVerifierText = previousVerifier
      ? this.contextManager.trimText(JSON.stringify(previousVerifier, null, 2), Math.floor(this.config.contextTokenBudget * 0.15))
      : 'None';

    await this.emitPhase(conversation, 'phase_started', 'plan', round, { indexedContextLength: indexedContext.length });
    try {
      return normalizeRoundPlan(
        await this.actorModel.generateJson<RoundPlan>(
          'You are planning a single execution round for a coding and data-analysis agent. Return strict JSON only.',
          buildRoundPlanningPrompt(prompt, indexedContext, previousVerifierText),
          { temperature: 0.1 },
        ),
        prompt,
      );
    } catch {
      return normalizeRoundPlan(undefined, prompt);
    } finally {
      await this.emitPhase(conversation, 'phase_completed', 'plan', round, {});
    }
  }

  private async maybeWriteFinalArtifact(session: SessionStore, finalMessage: string): Promise<string | undefined> {
    if (finalMessage.length <= this.config.toolOutputCharLimit) {
      return undefined;
    }

    return session.writeArtifact('final-response.txt', finalMessage);
  }

  private async runConversationTurn(conversation: ConversationState, prompt: string): Promise<TaskOutcome> {
    if (!this.actorModel.ready) {
      throw new Error('OPENAI_API_KEY is required for task and chat commands.');
    }

    const session = conversation.session;
    await session.appendEvent('user_prompt', { prompt, mode: conversation.mode });

    try {
      const hits = await this.index.search(prompt, 6).catch(() => []);
      let previousVerifier: VerifierResult | undefined;
      let lastBackend = 'local';
      let lastPlan = '';
      let lastFinalMessage = '';
      let lastDiff = '';
      let lastArtifacts: string[] = [];
      let roundsUsed = 0;
      let finalVerifier: VerifierResult = {
        status: 'FAIL',
        summary: 'The task did not complete.',
        evidence: [],
        missingChecks: [],
        nextAction: 'Inspect the execution history.',
      };

      const tools = createDefaultTools();
      const toolSpecs = toToolSpecs(tools);

      for (let round = 1; round <= this.config.maxExecutionRounds; round += 1) {
        roundsUsed = round;
        const roundPlan = await this.planRound(conversation, prompt, hits, round, previousVerifier);
        lastPlan = roundPlan.planMarkdown;
        await session.writePlan(roundPlan.planMarkdown);
        await session.appendEvent('round_started', {
          round,
          acceptanceChecks: roundPlan.acceptanceChecks,
          requiredEvidence: roundPlan.requiredEvidence,
          preferredBackend: roundPlan.preferredBackend,
        });
        await this.emitEvent(conversation, 'round_started', {
          round,
          data: {
            acceptanceChecks: roundPlan.acceptanceChecks,
            requiredEvidence: roundPlan.requiredEvidence,
            preferredBackend: roundPlan.preferredBackend,
          },
        });
        await this.callbacks.onPlan?.(roundPlan.planMarkdown, relativeToRoot(this.config, session.planPath));

        const { backend, selectionReason } = await this.backendFactory.select(roundPlan.preferredBackend, `Round ${round} backend selection.`);
        lastBackend = backend.name;
        await backend.prepare();
        await session.appendEvent('execution_backend', { round, backend: backend.name, selectionReason });

        const toolContext: ToolContext = {
          rootDir: this.config.rootDir,
          session,
          index: this.index,
          backend,
          toolOutputCharLimit: this.config.toolOutputCharLimit,
        };

        const indexedContext = this.contextManager.trimText(formatHits(hits), Math.floor(this.config.contextTokenBudget * 0.25));
        const previousVerifierText = previousVerifier
          ? this.contextManager.trimText(JSON.stringify(previousVerifier, null, 2), Math.floor(this.config.contextTokenBudget * 0.15))
          : 'None';
        conversation.messages.push({
          role: 'user',
          content: buildRoundExecutionPrompt(prompt, roundPlan, indexedContext, round, previousVerifierText),
        });

        const roundEvidence: EvidenceItem[] = [];
        const blockedReasons: string[] = [];
        const failures: string[] = [];
        const artifacts: string[] = [];
        let finalMessage = '';

        await this.emitPhase(conversation, 'phase_started', 'execute', round, { backend: backend.name });

        for (let step = 0; step < this.config.maxToolStepsPerRound; step += 1) {
          const prepared = await this.contextManager.prepareMessages(session, conversation.messages, {
            round,
            phase: 'execute',
            artifactReferences: conversation.artifactReferences,
          });
          await session.appendEvent('context_budget', {
            round,
            phase: 'execute',
            snapshot: prepared.snapshot,
          });

          const turn = await this.actorModel.completeWithTools(prepared.messages, toolSpecs, {
            onTextDelta: async (delta) => {
              await this.emitEvent(conversation, 'model_text_delta', {
                phase: 'execute',
                round,
                backend: backend.name,
                data: { delta },
              });
            },
          });
          conversation.messages.push(turn.rawMessage);
          if (turn.text) {
            await session.appendEvent('assistant_message', { round, step, content: turn.text });
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
              failures.push(errorMessage);
              await session.appendEvent('tool_error', { round, step, tool: toolCall.name, error: errorMessage });
              await this.emitEvent(conversation, 'tool_call_failed', {
                phase: 'execute',
                round,
                backend: backend.name,
                data: { tool: toolCall.name, error: errorMessage },
              });
              continue;
            }

            await this.emitEvent(conversation, 'tool_call_started', {
              phase: 'execute',
              round,
              backend: backend.name,
              data: { tool: tool.name, args: toolCall.args },
            });

            if (tool.approval !== 'read' && !this.config.autoApprove) {
              await this.emitEvent(conversation, 'approval_pending', {
                phase: 'execute',
                round,
                backend: backend.name,
                data: { toolName: tool.name, approval: tool.approval, args: toolCall.args },
              });
            }

            const approved = await maybeApprove(
              { sessionId: session.id, toolName: tool.name, approval: tool.approval, args: toolCall.args },
              this.approvalHandler,
              this.config.autoApprove,
            );

            if (tool.approval !== 'read' || this.config.autoApprove) {
              await this.emitEvent(conversation, 'approval_resolved', {
                phase: 'execute',
                round,
                backend: backend.name,
                data: { toolName: tool.name, decision: approved },
              });
            }

            if (!approved) {
              const denied = `Tool ${tool.name} was denied by the user.`;
              conversation.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: denied });
              blockedReasons.push(denied);
              await session.appendEvent('tool_denied', { round, step, tool: tool.name, args: toolCall.args });
              await this.emitEvent(conversation, 'tool_call_failed', {
                phase: 'execute',
                round,
                backend: backend.name,
                data: { tool: tool.name, error: denied },
              });
              continue;
            }

            try {
              const result = await tool.execute(toolCall.args, toolContext);
              conversation.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result.content });
              if (result.artifactPath) {
                artifacts.push(result.artifactPath);
                conversation.artifactReferences.push(result.artifactPath);
              }
              roundEvidence.push(...buildEvidenceFromTool(tool.name, result.metadata, result.artifactPath));
              await session.appendEvent('tool_result', {
                round,
                step,
                tool: tool.name,
                args: toolCall.args,
                artifactPath: result.artifactPath,
                metadata: result.metadata,
              });
              await this.emitEvent(conversation, 'tool_call_completed', {
                phase: 'execute',
                round,
                backend: backend.name,
                data: {
                  tool: tool.name,
                  artifactPath: result.artifactPath,
                  metadata: result.metadata,
                },
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              conversation.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: `Tool error: ${message}` });
              failures.push(`${tool.name}: ${message}`);
              await session.appendEvent('tool_error', { round, step, tool: tool.name, args: toolCall.args, error: message });
              await this.emitEvent(conversation, 'tool_call_failed', {
                phase: 'execute',
                round,
                backend: backend.name,
                data: { tool: tool.name, error: message },
              });
            }
          }
        }

        if (!finalMessage) {
          finalMessage = 'Reached the per-round tool step limit before the model produced a final answer.';
        }
        lastFinalMessage = finalMessage;

        const finalArtifact = await this.maybeWriteFinalArtifact(session, finalMessage);
        if (finalArtifact) {
          artifacts.push(finalArtifact);
          conversation.artifactReferences.push(finalArtifact);
        }

        const diff = await session.renderDiff();
        lastDiff = diff;
        if (diff) {
          const diffArtifact = await session.writeArtifact('workspace-diff.patch', diff);
          artifacts.push(diffArtifact);
          conversation.artifactReferences.push(diffArtifact);
          roundEvidence.push({
            kind: 'diff',
            summary: `Workspace diff captured for round ${round}.`,
            artifactPath: diffArtifact,
            passed: true,
          });
        }

        await this.emitPhase(conversation, 'phase_completed', 'execute', round, {
          backend: backend.name,
          artifacts,
        });

        const bundle: EvidenceBundle = {
          task: prompt,
          round,
          backend: backend.name,
          plan: roundPlan.planMarkdown,
          finalMessage,
          diff,
          touchedFiles: session.touchedFiles(),
          acceptanceChecks: roundPlan.acceptanceChecks,
          requiredEvidence: roundPlan.requiredEvidence,
          evidence: roundEvidence,
          blockedReasons,
          failures,
        };

        await this.emitPhase(conversation, 'phase_started', 'verify', round, { backend: backend.name });
        const verifierResult = await verifyWithFallback(this.ruleVerifier, this.modelVerifier, bundle);
        finalVerifier = verifierResult;
        previousVerifier = verifierResult;
        lastArtifacts = [...new Set([...artifacts, ...(conversation.artifactReferences.slice(-12))])];

        await session.appendEvent('verifier_result', {
          round,
          backend: backend.name,
          verifierResult,
          evidenceArtifacts: artifacts,
          acceptanceChecks: roundPlan.acceptanceChecks,
        });
        await this.emitEvent(conversation, 'verifier_result', {
          phase: 'verify',
          round,
          backend: backend.name,
          data: {
            verifierResult,
            acceptanceChecks: roundPlan.acceptanceChecks,
            evidenceArtifacts: artifacts,
          },
        });
        await this.emitPhase(conversation, 'phase_completed', 'verify', round, {
          backend: backend.name,
          status: verifierResult.status,
        });
        await session.appendEvent('round_completed', {
          round,
          status: verifierResult.status,
          backend: backend.name,
        });
        await this.emitEvent(conversation, 'round_completed', {
          round,
          backend: backend.name,
          data: { status: verifierResult.status },
        });

        if (verifierResult.status === 'PASS' || verifierResult.status === 'BLOCKED') {
          break;
        }
      }

      await session.appendEvent('final', {
        status: finalVerifier.status,
        rounds: roundsUsed,
        backend: lastBackend,
        finalMessage: lastFinalMessage,
        verification: finalVerifier.summary,
        verifierResult: finalVerifier,
        artifacts: lastArtifacts,
        finalStatus: finalVerifier.status,
      });
      await this.emitEvent(conversation, 'final_result', {
        round: roundsUsed,
        backend: lastBackend,
        data: {
          status: finalVerifier.status,
          rounds: roundsUsed,
          backend: lastBackend,
          finalMessage: lastFinalMessage,
          verification: finalVerifier.summary,
          artifacts: lastArtifacts,
        },
      });
      await this.callbacks.onFinal?.(lastFinalMessage);

      return {
        sessionId: session.id,
        status: finalVerifier.status,
        rounds: roundsUsed,
        backend: lastBackend,
        plan: lastPlan,
        finalMessage: lastFinalMessage,
        verification: finalVerifier.summary,
        verifierResult: finalVerifier,
        diff: lastDiff,
        artifacts: lastArtifacts,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await session.appendEvent('error', { message });
      await this.emitEvent(conversation, 'error', { data: { message } });
      throw error;
    }
  }

  close(): void {
    void this.backendFactory.close();
    this.index.close();
  }
}
