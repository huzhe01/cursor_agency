import { Command } from 'commander';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import process from 'node:process';
import { AgencyRuntime, ensureWorkspaceDirs, loadConfig, renderDoctorReport, startConsoleServer, type ApprovalRequest } from '@agency/core';

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
  return {
    config,
    runtime: new AgencyRuntime(config, approvalPrompt, {
      async onPlan(plan, planPath) {
        console.log(`\n[plan] ${planPath}\n${plan}\n`);
      },
      async onInfo(message) {
        console.log(`[info] ${message}`);
      },
      async onFinal(message) {
        console.log(`\n[final]\n${message}\n`);
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
