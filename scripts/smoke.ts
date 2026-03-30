import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureWorkspaceDirs, loadConfig, renderDoctorReport } from '@agency/core';
import { SQLiteIndexProvider } from '@agency/indexer';
import { createDefaultTools, type SessionLike } from '@agency/tools';

class SmokeSession implements SessionLike {
  private readonly artifacts = path.join(process.cwd(), '.agency', 'smoke-artifacts');

  async captureOriginal(): Promise<void> {
    return;
  }

  async renderDiff(): Promise<string> {
    return '';
  }

  async writeArtifact(name: string, content: string): Promise<string> {
    await fs.mkdir(this.artifacts, { recursive: true });
    const target = path.join(this.artifacts, name);
    await fs.writeFile(target, content, 'utf8');
    return path.relative(process.cwd(), target);
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.cwd());
  ensureWorkspaceDirs(config);
  console.log(renderDoctorReport(config));

  const index = new SQLiteIndexProvider({
    rootDir: config.rootDir,
    dbPath: config.indexPath,
  });

  try {
    const stats = await index.build();
    console.log(`smoke:indexed=${stats.indexedFiles} scanned=${stats.scannedFiles}`);
    const hits = await index.search('agency runtime', 3);
    console.log(`smoke:hits=${hits.length}`);

    const tools = createDefaultTools();
    const replaceTool = tools.find((tool) => tool.name === 'replace_exact_text');
    const readTool = tools.find((tool) => tool.name === 'read_file');
    if (!replaceTool || !readTool) {
      throw new Error('Expected replace_exact_text and read_file tools to be registered.');
    }

    const session = new SmokeSession();
    const smokeFile = path.join(config.cacheDir, 'smoke-replace.txt');
    await fs.mkdir(path.dirname(smokeFile), { recursive: true });
    await fs.writeFile(smokeFile, 'alpha\nbeta\nalpha\n', 'utf8');

    const dryRun = await replaceTool.execute({
      path: path.relative(config.rootDir, smokeFile),
      old_text: 'alpha',
      new_text: 'omega',
      dry_run: true,
      expected_occurrences: 2,
    }, {
      rootDir: config.rootDir,
      session,
      index,
      backend: {
        name: 'local',
        async prepare() {},
        async runShell() { throw new Error('unused'); },
        async runPythonScript() { throw new Error('unused'); },
        async runDuckDbSql() { throw new Error('unused'); },
        async inspectTable() { throw new Error('unused'); },
        async assertTableChecks() { throw new Error('unused'); },
      },
      toolOutputCharLimit: config.toolOutputCharLimit,
    });
    console.log(`smoke:replace_preview=${dryRun.artifactPath ? 'yes' : 'no'}`);

    const paged = await readTool.execute({
      path: path.relative(config.rootDir, smokeFile),
      start_line: 2,
      max_lines: 1,
    }, {
      rootDir: config.rootDir,
      session,
      index,
      backend: {
        name: 'local',
        async prepare() {},
        async runShell() { throw new Error('unused'); },
        async runPythonScript() { throw new Error('unused'); },
        async runDuckDbSql() { throw new Error('unused'); },
        async inspectTable() { throw new Error('unused'); },
        async assertTableChecks() { throw new Error('unused'); },
      },
      toolOutputCharLimit: config.toolOutputCharLimit,
    });
    console.log(`smoke:paged_read=${paged.content.includes('2 | beta')}`);
  } finally {
    index.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
