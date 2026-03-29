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
    `auto_approve: ${config.autoApprove}`,
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
  ];

  if (!config.openaiApiKey) {
    lines.push('', 'warning: OPENAI_API_KEY is missing, so task/chat tool calls and embeddings will not run.');
  }

  return lines.join('\n');
}
