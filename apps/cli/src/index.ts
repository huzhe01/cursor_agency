import { Command } from 'commander';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import process from 'node:process';
import { AgencyRuntime, ensureWorkspaceDirs, loadConfig, renderDoctorReport, startConsoleServer, type ApprovalRequest } from '@agency/core';
import type { RuntimeEvent } from '@agency/core';

const rootDir = process.cwd();
const envPath = path.join(rootDir, '.env.local');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

async function approvalPrompt(request: ApprovalRequest): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(
      `Approve ${request.approval} tool ${request.toolName} with args ${JSON.stringify(request.args)}? [y/N] `,
    );
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

function createRuntime() {
  const config = loadConfig(rootDir);
  ensureWorkspaceDirs(config);
  let streamingAssistant = false;

  const flushAssistant = () => {
    if (streamingAssistant) {
      process.stdout.write('\n');
      streamingAssistant = false;
    }
  };

  return {
    config,
    runtime: new AgencyRuntime(config, approvalPrompt, {
      async onEvent(event: RuntimeEvent) {
        if (event.type === 'model_text_delta') {
          if (!streamingAssistant) {
            process.stdout.write('\n[assistant]\n');
            streamingAssistant = true;
          }
          process.stdout.write(String(event.data?.delta ?? ''));
          return;
        }

        flushAssistant();
        if (event.type === 'round_started') {
          console.log(`\n[round ${event.round}]`);
          return;
        }
        if (event.type === 'phase_started') {
          console.log(`[phase] ${event.phase}${event.backend ? ` | backend=${event.backend}` : ''}`);
          return;
        }
        if (event.type === 'tool_call_started') {
          console.log(`[tool:start] ${String(event.data?.tool ?? 'unknown')}`);
          return;
        }
        if (event.type === 'tool_call_completed') {
          const metadata = typeof event.data?.metadata === 'object' && event.data?.metadata ? JSON.stringify(event.data.metadata) : '';
          console.log(`[tool:done] ${String(event.data?.tool ?? 'unknown')}${metadata ? ` ${metadata}` : ''}`);
          return;
        }
        if (event.type === 'tool_call_failed') {
          console.log(`[tool:error] ${String(event.data?.tool ?? 'unknown')} ${String(event.data?.error ?? '')}`.trim());
          return;
        }
        if (event.type === 'approval_pending') {
          console.log(`[approval] ${String(event.data?.toolName ?? 'unknown')} (${String(event.data?.approval ?? 'unknown')})`);
          return;
        }
        if (event.type === 'approval_resolved') {
          console.log(`[approval:${event.data?.decision ? 'approved' : 'denied'}] ${String(event.data?.toolName ?? 'unknown')}`);
          return;
        }
        if (event.type === 'verifier_result') {
          const status = String((event.data?.verifierResult as { status?: string } | undefined)?.status ?? 'unknown');
          console.log(`[verifier] ${status}`);
          return;
        }
        if (event.type === 'final_result') {
          console.log(`[result] ${String(event.data?.status ?? 'unknown')} | rounds=${String(event.data?.rounds ?? '?')} | backend=${String(event.data?.backend ?? 'local')}`);
          return;
        }
        if (event.type === 'error') {
          console.log(`[error] ${String(event.data?.message ?? 'unknown error')}`);
        }
      },
    }),
  };
}

const program = new Command();
program.name('agency').description('Docker-only Cursor primitive CLI').showHelpAfterError();

program
  .command('doctor')
  .description('Show environment, dependency, and state checks')
  .action(async () => {
    const { config } = createRuntime();
    console.log(renderDoctorReport(config));
  });

program
  .command('index')
  .description('Build or refresh the local SQLite code index')
  .option('--watch', 'Watch for file changes and reindex automatically')
  .action(async (options: { watch?: boolean }) => {
    const { runtime } = createRuntime();
    try {
      const stats = await runtime.buildIndex();
      console.log(`Indexed ${stats.indexedFiles} changed files across ${stats.scannedFiles} scanned files.`);
      if (options.watch) {
        console.log('Watching for changes. Press Ctrl+C to stop.');
        await runtime.watchIndex();
      }
    } finally {
      runtime.close();
    }
  });

program
  .command('task')
  .description('Run a single plan-execute-verify task')
  .argument('<prompt...>', 'Task prompt')
  .action(async (promptParts: string[]) => {
    const prompt = promptParts.join(' ');
    const { runtime } = createRuntime();
    try {
      const outcome = await runtime.runTask(prompt, 'task');
      console.log(`[session] ${outcome.sessionId}`);
      console.log(`[status] ${outcome.status}`);
      console.log(`[rounds] ${outcome.rounds}`);
      console.log(`[backend] ${outcome.backend}`);
      console.log(`\n[verification]\n${outcome.verification}\n`);
      if (outcome.diff) {
        console.log(`[diff]\n${outcome.diff}`);
      }
    } finally {
      runtime.close();
    }
  });

program
  .command('chat')
  .description('Start an interactive REPL with session logging')
  .action(async () => {
    const { runtime } = createRuntime();
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const chat = await runtime.createChatSession();
      console.log(`Type /exit to leave the chat session. [session] ${chat.session.id}`);
      while (true) {
        let input = '';
        try {
          input = (await rl.question('agency> ')).trim();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('readline was closed')) {
            break;
          }
          throw error;
        }
        if (!input) {
          continue;
        }
        if (input === '/exit') {
          break;
        }
        const outcome = await chat.prompt(input);
        console.log(`\n[final]\n${outcome.finalMessage}\n`);
        console.log(`[status] ${outcome.status} | [rounds] ${outcome.rounds} | [backend] ${outcome.backend}`);
        console.log(`\n[verification]\n${outcome.verification}\n`);
      }
    } finally {
      rl.close();
      runtime.close();
    }
  });

program
  .command('web')
  .description('Start the minimal browser console for tasks and sessions')
  .option('--port <port>', 'Port to bind', '3000')
  .action(async (options: { port: string }) => {
    const { runtime, config } = createRuntime();
    const port = Number(options.port);
    try {
      const server = await startConsoleServer(runtime, config, port);
      console.log(`Agency console running at http://127.0.0.1:${port}`);
      await new Promise<void>((resolve) => {
        const shutdown = () => {
          server.close(() => resolve());
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      });
    } finally {
      runtime.close();
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[error] ${message}`);
  process.exitCode = 1;
});
