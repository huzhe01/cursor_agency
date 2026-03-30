import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AgencyConfig } from './config.js';

function hasCommand(command: string): boolean {
  const result = spawnSync('bash', ['-lc', `command -v ${command}`], { stdio: 'ignore' });
  return result.status === 0;
}

export function renderDoctorReport(config: AgencyConfig): string {
  const lines = [
    `provider: ${config.providerName}`,
    `root_dir: ${config.rootDir}`,
    `state_dir: ${config.stateDir}`,
    `cache_dir: ${config.cacheDir}`,
    `session_dir: ${config.sessionDir}`,
    `index_path: ${config.indexPath}`,
    `openai_api_key: ${config.openaiApiKey ? 'configured' : 'missing'}`,
    `openai_model: ${config.openaiModel}`,
    `openai_embed_model: ${config.openaiEmbedModel}`,
    `openai_base_url: ${config.openaiBaseUrl ?? '(default)'}`,
    `verifier_api_key: ${config.verifierApiKey ? 'configured' : 'missing'}`,
    `verifier_model: ${config.verifierModel}`,
    `verifier_base_url: ${config.verifierBaseUrl ?? '(default)'}`,
    `default_backend: ${config.defaultBackend}`,
    `e2b_api_key: ${config.e2bApiKey ? 'configured' : 'missing'}`,
    `auto_approve: ${config.autoApprove}`,
    `max_execution_rounds: ${config.maxExecutionRounds}`,
    `max_tool_steps_per_round: ${config.maxToolStepsPerRound}`,
    `context_token_budget: ${config.contextTokenBudget}`,
    `context_reserve_tokens: ${config.contextReserveTokens}`,
    `tool_output_char_limit: ${config.toolOutputCharLimit}`,
    `summary_trigger_ratio: ${config.summaryTriggerRatio}`,
    '',
    'commands:',
    `  git: ${hasCommand('git')}`,
    `  rg: ${hasCommand('rg')}`,
    `  fd: ${hasCommand('fd')}`,
    `  sqlite3: ${hasCommand('sqlite3')}`,
    `  python3: ${hasCommand('python3')}`,
    `  uv: ${hasCommand('uv')}`,
    '',
    'paths:',
    `  root_exists: ${fs.existsSync(config.rootDir)}`,
    `  state_exists: ${fs.existsSync(config.stateDir)}`,
    `  cache_exists: ${fs.existsSync(config.cacheDir)}`,
    `  env_local_present: ${fs.existsSync(path.join(config.rootDir, '.env.local'))}`,
    `  index_present: ${fs.existsSync(config.indexPath)}`,
    `  python_env_present: ${fs.existsSync(path.join(config.cacheDir, 'python', '.venv', 'bin', 'python'))}`,
  ];

  if (!config.openaiApiKey) {
    lines.push('', 'warning: OPENAI_API_KEY is missing, so task/chat tool calls and embeddings will not run.');
  }

  return lines.join('\n');
}
