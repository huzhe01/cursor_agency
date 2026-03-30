import { createTwoFilesPatch } from 'diff';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface SessionEvent {
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface SessionSummary {
  id: string;
  mode: 'task' | 'chat';
  createdAt: string;
  prompt: string;
  status: string;
  rounds: number;
  backend: string;
  phase?: string;
  finalMessage: string;
  verification: string;
  planPath: string;
  eventsPath: string;
}

export interface SessionDetail extends SessionSummary {
  plan: string;
  events: SessionEvent[];
  diff: string;
  artifacts: string[];
  verifierResult?: Record<string, unknown>;
  acceptanceChecks: Array<Record<string, unknown>>;
  evidenceArtifacts: string[];
  contextSummaryArtifact?: string;
  contextBudgetSnapshot?: Record<string, unknown>;
  streamArtifacts: string[];
}

export class SessionStore {
  readonly id: string;
  readonly mode: 'task' | 'chat';
  readonly sessionDir: string;
  readonly artifactDir: string;
  readonly eventsPath: string;
  readonly planPath: string;

  private readonly rootDir: string;
  private readonly originals = new Map<string, string>();

  private constructor(rootDir: string, mode: 'task' | 'chat', id: string, sessionDir: string) {
    this.rootDir = rootDir;
    this.mode = mode;
    this.id = id;
    this.sessionDir = sessionDir;
    this.artifactDir = path.join(sessionDir, 'artifacts');
    this.eventsPath = path.join(sessionDir, 'events.jsonl');
    this.planPath = path.join(sessionDir, 'plan.md');
  }

  static async create(rootDir: string, sessionRoot: string, mode: 'task' | 'chat'): Promise<SessionStore> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const id = `${timestamp}-${randomUUID().slice(0, 8)}`;
    const sessionDir = path.join(sessionRoot, id);
    await fs.mkdir(path.join(sessionDir, 'artifacts'), { recursive: true });
    return new SessionStore(rootDir, mode, id, sessionDir);
  }

  async appendEvent(type: string, payload: Record<string, unknown>): Promise<void> {
    const event: SessionEvent = {
      timestamp: new Date().toISOString(),
      type,
      payload,
    };
    await fs.appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
  }

  async writePlan(content: string): Promise<void> {
    await fs.writeFile(this.planPath, content, 'utf8');
    await this.appendEvent('plan', { path: this.planPath });
  }

  async writeArtifact(name: string, content: string): Promise<string> {
    const safeName = name.replace(/[^a-zA-Z0-9._-]+/g, '-');
    const targetPath = path.join(this.artifactDir, safeName);
    await fs.writeFile(targetPath, content, 'utf8');
    const relativePath = path.relative(this.rootDir, targetPath);
    await this.appendEvent('artifact', { path: relativePath });
    return relativePath;
  }

  async captureOriginal(filePath: string): Promise<void> {
    if (this.originals.has(filePath)) {
      return;
    }

    try {
      const content = await fs.readFile(filePath, 'utf8');
      this.originals.set(filePath, content);
    } catch {
      this.originals.set(filePath, '');
    }
  }

  async renderDiff(targetPath?: string): Promise<string> {
    const patches: string[] = [];
    const files = targetPath ? [targetPath] : [...this.originals.keys()];

    for (const filePath of files) {
      const original = this.originals.get(filePath) ?? '';
      let current = '';
      try {
        current = await fs.readFile(filePath, 'utf8');
      } catch {
        current = '';
      }

      if (original === current) {
        continue;
      }

      const relativePath = path.relative(this.rootDir, filePath);
      patches.push(createTwoFilesPatch(relativePath, relativePath, original, current, 'before', 'after'));
    }

    return patches.join('\n');
  }

  touchedFiles(): string[] {
    return [...this.originals.keys()].map((filePath) => path.relative(this.rootDir, filePath));
  }
}

async function readJsonLines(filePath: string): Promise<SessionEvent[]> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SessionEvent);
  } catch {
    return [];
  }
}

function extractSummary(id: string, sessionDir: string, events: SessionEvent[]): SessionSummary {
  const firstPrompt = events.find((event) => event.type === 'user_prompt')?.payload.prompt;
  const finalEvent = [...events].reverse().find((event: SessionEvent) => event.type === 'final');
  const phaseEvent = [...events].reverse().find((event) => event.type === 'phase_started' || event.type === 'phase_completed');
  const mode = ((events.find((event) => event.type === 'user_prompt')?.payload.mode
    ?? events.find((event) => event.type === 'session_started')?.payload.mode) as 'task' | 'chat' | undefined) ?? 'task';
  return {
    id,
    mode,
    createdAt: id.split('-').slice(0, 6).join('-'),
    prompt: typeof firstPrompt === 'string' ? firstPrompt : '',
    status: typeof finalEvent?.payload.status === 'string' ? finalEvent.payload.status : 'completed',
    rounds: typeof finalEvent?.payload.rounds === 'number' ? finalEvent.payload.rounds : 0,
    backend: typeof finalEvent?.payload.backend === 'string' ? finalEvent.payload.backend : 'local',
    phase: typeof phaseEvent?.payload.phase === 'string' ? phaseEvent.payload.phase : undefined,
    finalMessage: typeof finalEvent?.payload.finalMessage === 'string' ? finalEvent.payload.finalMessage : '',
    verification: typeof finalEvent?.payload.verification === 'string' ? finalEvent.payload.verification : '',
    planPath: path.join(sessionDir, 'plan.md'),
    eventsPath: path.join(sessionDir, 'events.jsonl'),
  };
}

export async function listSessions(sessionRoot: string): Promise<SessionSummary[]> {
  try {
    const entries = await fs.readdir(sessionRoot, { withFileTypes: true });
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const sessionDir = path.join(sessionRoot, entry.name);
          const events = await readJsonLines(path.join(sessionDir, 'events.jsonl'));
          return extractSummary(entry.name, sessionDir, events);
        }),
    );

    return sessions.sort((left, right) => right.id.localeCompare(left.id));
  } catch {
    return [];
  }
}

export async function readSessionDetail(rootDir: string, sessionRoot: string, sessionId: string): Promise<SessionDetail | null> {
  const sessionDir = path.join(sessionRoot, sessionId);
  try {
    const [events, plan, artifacts] = await Promise.all([
      readJsonLines(path.join(sessionDir, 'events.jsonl')),
      fs.readFile(path.join(sessionDir, 'plan.md'), 'utf8').catch(() => ''),
      fs.readdir(path.join(sessionDir, 'artifacts')).catch(() => []),
    ]);
    const summary = extractSummary(sessionId, sessionDir, events);
    const sortedArtifacts = [...artifacts].sort();
    const diffArtifact = sortedArtifacts.find((artifact) => artifact === 'workspace-diff.patch')
      ?? [...sortedArtifacts].reverse().find((artifact) => artifact.endsWith('.patch'));
    const diff = diffArtifact ? await fs.readFile(path.join(sessionDir, 'artifacts', diffArtifact), 'utf8').catch(() => '') : '';
    const verifierEvent = [...events].reverse().find((event) => event.type === 'verifier_result');
    const contextEvent = [...events].reverse().find((event) => event.type === 'context_budget');
    const finalEvent = [...events].reverse().find((event) => event.type === 'final');
    return {
      ...summary,
      plan,
      events,
      diff,
      artifacts: sortedArtifacts.map((artifact) => path.relative(rootDir, path.join(sessionDir, 'artifacts', artifact))),
      verifierResult: verifierEvent?.payload.verifierResult as Record<string, unknown> | undefined,
      acceptanceChecks: Array.isArray(verifierEvent?.payload.acceptanceChecks) ? verifierEvent?.payload.acceptanceChecks as Array<Record<string, unknown>> : [],
      evidenceArtifacts: Array.isArray(verifierEvent?.payload.evidenceArtifacts) ? verifierEvent?.payload.evidenceArtifacts as string[] : [],
      contextSummaryArtifact: typeof (contextEvent?.payload.snapshot as Record<string, unknown> | undefined)?.summaryArtifactPath === 'string'
        ? (contextEvent?.payload.snapshot as Record<string, unknown>).summaryArtifactPath as string
        : undefined,
      contextBudgetSnapshot: typeof contextEvent?.payload.snapshot === 'object' && contextEvent.payload.snapshot
        ? contextEvent.payload.snapshot as Record<string, unknown>
        : undefined,
      streamArtifacts: Array.isArray(finalEvent?.payload.artifacts) ? finalEvent?.payload.artifacts as string[] : [],
    };
  } catch {
    return null;
  }
}
