import fs from 'node:fs';
import path from 'node:path';

export interface AgencyConfig {
  rootDir: string;
  stateDir: string;
  cacheDir: string;
  sessionDir: string;
  indexPath: string;
  maxToolStepsPerRound: number;
  maxExecutionRounds: number;
  autoApprove: boolean;
  openaiApiKey?: string;
  openaiModel: string;
  openaiEmbedModel: string;
  openaiBaseUrl?: string;
  verifierApiKey?: string;
  verifierModel: string;
  verifierBaseUrl?: string;
  defaultBackend: 'local' | 'e2b';
  e2bApiKey?: string;
  e2bTemplateId?: string;
  providerName: string;
}

export function loadConfig(rootDir = process.cwd()): AgencyConfig {
  const resolvedRoot = path.resolve(process.env.AGENCY_ROOT ?? rootDir);
  const stateDir = path.resolve(process.env.AGENCY_STATE_DIR ?? path.join(resolvedRoot, '.agency'));
  const cacheDir = path.join(resolvedRoot, '.cache');
  const sessionDir = path.join(stateDir, 'sessions');
  const indexPath = path.join(stateDir, 'index.sqlite');
  const arkApiKey = process.env.ARK_API_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY ?? arkApiKey;
  const openaiBaseUrl = process.env.OPENAI_BASE_URL ?? process.env.ARK_BASE_URL;
  const arkEndpointId = process.env.ARK_ENDPOINT_ID;
  const openaiModel = process.env.OPENAI_MODEL ?? arkEndpointId ?? 'gpt-4.1-mini';
  const openaiEmbedModel = process.env.OPENAI_EMBED_MODEL ?? arkEndpointId ?? 'text-embedding-3-small';
  const verifierApiKey = process.env.VERIFIER_API_KEY ?? openaiApiKey;
  const verifierBaseUrl = process.env.VERIFIER_BASE_URL ?? openaiBaseUrl;
  const verifierModel = process.env.VERIFIER_MODEL ?? openaiModel;
  const defaultBackend = process.env.AGENCY_DEFAULT_BACKEND === 'e2b' ? 'e2b' : 'local';

  return {
    rootDir: resolvedRoot,
    stateDir,
    cacheDir,
    sessionDir,
    indexPath,
    maxToolStepsPerRound: Number(process.env.AGENCY_MAX_TOOL_STEPS ?? 10),
    maxExecutionRounds: Number(process.env.AGENCY_MAX_EXECUTION_ROUNDS ?? 3),
    autoApprove: process.env.AGENCY_AUTO_APPROVE === 'true',
    openaiApiKey,
    openaiModel,
    openaiEmbedModel,
    openaiBaseUrl,
    verifierApiKey,
    verifierModel,
    verifierBaseUrl,
    defaultBackend,
    e2bApiKey: process.env.E2B_API_KEY,
    e2bTemplateId: process.env.E2B_TEMPLATE_ID,
    providerName: arkApiKey ? 'volcengine-ark' : 'openai-compatible',
  };
}

export function ensureWorkspaceDirs(config: AgencyConfig): void {
  for (const directory of [config.stateDir, config.cacheDir, config.sessionDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

export function relativeToRoot(config: AgencyConfig, targetPath: string): string {
  return path.relative(config.rootDir, targetPath) || '.';
}
