import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  BackendCommandResult,
  DuckDbSqlRequest,
  DuckDbSqlResult,
  ExecutionBackend,
  PythonScriptRequest,
  TableCheck,
  TableCheckResult,
  TableInspectionResult,
} from '@agency/tools';
import { parseJsonOutput } from './json.js';

interface BackendConfig {
  rootDir: string;
  cacheDir: string;
  defaultBackend: 'local' | 'e2b';
  e2bApiKey?: string;
  e2bTemplateId?: string;
}

interface CommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function resolvePath(rootDir: string, candidate: string): string {
  const absolutePath = path.resolve(rootDir, candidate);
  const relativePath = path.relative(rootDir, absolutePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Path ${candidate} escapes the workspace root.`);
  }

  return absolutePath;
}

async function runLocalCommand(command: string, cwd: string): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-lc', command], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function shellQuote(value: string): string {
  return JSON.stringify(value);
}

abstract class BaseExecutionBackend implements ExecutionBackend {
  abstract readonly name: string;
  protected readonly rootDir: string;

  protected constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  abstract prepare(): Promise<void>;

  abstract runShell(command: string, options?: { cwd?: string; inputPaths?: string[]; outputPaths?: string[] }): Promise<BackendCommandResult>;

  abstract runPythonScript(request: PythonScriptRequest): Promise<BackendCommandResult>;

  async close(): Promise<void> {
    // subclasses may override when teardown is required
  }

  async runDuckDbSql(request: DuckDbSqlRequest): Promise<DuckDbSqlResult> {
    const sqlLiteral = JSON.stringify(request.sql);
    const databaseLiteral = JSON.stringify(request.databasePath ?? ':memory:');
    const sampleRows = request.sampleRows ?? 10;
    const script = `
import duckdb
import json

sql = ${sqlLiteral}
database_path = ${databaseLiteral}
sample_rows = ${sampleRows}

conn = duckdb.connect(database_path)
cursor = conn.execute(sql)
columns = [column[0] for column in (cursor.description or [])]
rows = []
if columns:
    fetched = cursor.fetchmany(sample_rows)
    rows = [dict(zip(columns, row)) for row in fetched]
    try:
        row_count = conn.execute(f"SELECT COUNT(*) FROM ({sql}) AS __agency_subquery").fetchone()[0]
    except Exception:
        row_count = len(rows)
else:
    row_count = 0

print(json.dumps({
    "rowCount": int(row_count),
    "columns": columns,
    "rows": rows,
    "databasePath": database_path,
    "sql": sql,
}))
`;
    const result = await this.runPythonScript({
      script,
      cwd: request.cwd,
      inputPaths: request.databasePath ? [request.databasePath] : [],
    });
    if (result.exitCode !== 0) {
      throw new Error(`DuckDB SQL execution failed on backend ${this.name}: ${result.stderr || result.stdout}`);
    }
    const parsed = parseJsonOutput<{
      rowCount: number;
      columns: string[];
      rows: Array<Record<string, unknown>>;
      databasePath?: string;
      sql: string;
    }>(result.stdout);
    return {
      backend: this.name,
      rowCount: parsed.rowCount,
      columns: parsed.columns,
      rows: parsed.rows,
      databasePath: parsed.databasePath,
      sql: parsed.sql,
      metadata: {
        stderr: result.stderr,
        generatedFiles: result.generatedFiles,
      },
    };
  }

  async inspectTable(request: { table: string; databasePath?: string; cwd?: string; sampleRows?: number }): Promise<TableInspectionResult> {
    const quotedTable = request.table.replace(/"/g, '""');
    const describe = await this.runDuckDbSql({
      sql: `DESCRIBE SELECT * FROM "${quotedTable}"`,
      databasePath: request.databasePath,
      cwd: request.cwd,
      sampleRows: 100,
    });
    const sample = await this.runDuckDbSql({
      sql: `SELECT * FROM "${quotedTable}" LIMIT ${request.sampleRows ?? 10}`,
      databasePath: request.databasePath,
      cwd: request.cwd,
      sampleRows: request.sampleRows ?? 10,
    });
    const rowCount = await this.runDuckDbSql({
      sql: `SELECT COUNT(*) AS count FROM "${quotedTable}"`,
      databasePath: request.databasePath,
      cwd: request.cwd,
      sampleRows: 1,
    });

    return {
      backend: this.name,
      table: request.table,
      rowCount: Number(rowCount.rows[0]?.count ?? 0),
      columns: describe.rows.map((row) => String(row.column_name ?? row.column ?? '')),
      sampleRows: sample.rows,
      databasePath: request.databasePath,
    };
  }

  async assertTableChecks(request: { table: string; databasePath?: string; cwd?: string; checks: TableCheck[] }): Promise<TableCheckResult> {
    const inspection = await this.inspectTable({
      table: request.table,
      databasePath: request.databasePath,
      cwd: request.cwd,
      sampleRows: 5,
    });

    const failures: string[] = [];
    const details: Array<Record<string, unknown>> = [];

    for (const check of request.checks) {
      if (check.type === 'row_count') {
        const actual = inspection.rowCount;
        const passed = actual === Number(check.equals);
        if (!passed) {
          failures.push(`Expected row_count=${check.equals} but found ${actual}.`);
        }
        details.push({ type: check.type, expected: check.equals, actual, passed });
        continue;
      }

      if (check.type === 'columns_exact') {
        const expected = check.columns ?? [];
        const actual = inspection.columns;
        const passed = JSON.stringify(expected) === JSON.stringify(actual);
        if (!passed) {
          failures.push(`Expected columns ${expected.join(', ')} but found ${actual.join(', ')}.`);
        }
        details.push({ type: check.type, expected, actual, passed });
        continue;
      }

      if (check.type === 'no_nulls') {
        if (!check.column) {
          failures.push('no_nulls check requires a column.');
          details.push({ type: check.type, passed: false, error: 'missing column' });
          continue;
        }
        const result = await this.runDuckDbSql({
          sql: `SELECT COUNT(*) AS count FROM "${request.table.replace(/"/g, '""')}" WHERE "${check.column.replace(/"/g, '""')}" IS NULL`,
          databasePath: request.databasePath,
          cwd: request.cwd,
          sampleRows: 1,
        });
        const actual = Number(result.rows[0]?.count ?? 0);
        const passed = actual === 0;
        if (!passed) {
          failures.push(`Expected no_nulls for ${check.column}, found ${actual} null rows.`);
        }
        details.push({ type: check.type, column: check.column, actual, passed });
        continue;
      }

      if (check.type === 'value_range') {
        if (!check.column) {
          failures.push('value_range check requires a column.');
          details.push({ type: check.type, passed: false, error: 'missing column' });
          continue;
        }
        const result = await this.runDuckDbSql({
          sql: `SELECT MIN("${check.column.replace(/"/g, '""')}") AS min_value, MAX("${check.column.replace(/"/g, '""')}") AS max_value FROM "${request.table.replace(/"/g, '""')}"`,
          databasePath: request.databasePath,
          cwd: request.cwd,
          sampleRows: 1,
        });
        const actualMin = Number(result.rows[0]?.min_value);
        const actualMax = Number(result.rows[0]?.max_value);
        const passed = (check.min == null || actualMin >= check.min) && (check.max == null || actualMax <= check.max);
        if (!passed) {
          failures.push(`Expected value_range for ${check.column} within [${check.min ?? '-inf'}, ${check.max ?? '+inf'}], found [${actualMin}, ${actualMax}].`);
        }
        details.push({ type: check.type, column: check.column, min: check.min, max: check.max, actualMin, actualMax, passed });
        continue;
      }

      if (check.type === 'aggregate_equals') {
        if (!check.expr) {
          failures.push('aggregate_equals check requires expr.');
          details.push({ type: check.type, passed: false, error: 'missing expr' });
          continue;
        }
        const result = await this.runDuckDbSql({
          sql: `SELECT (${check.expr}) AS actual FROM "${request.table.replace(/"/g, '""')}"`,
          databasePath: request.databasePath,
          cwd: request.cwd,
          sampleRows: 1,
        });
        const actual = result.rows[0]?.actual;
        const passed = actual === check.equals;
        if (!passed) {
          failures.push(`Expected aggregate ${check.expr} to equal ${String(check.equals)}, found ${String(actual)}.`);
        }
        details.push({ type: check.type, expr: check.expr, expected: check.equals, actual, passed });
      }
    }

    return {
      backend: this.name,
      passed: failures.length === 0,
      failures,
      details,
      table: request.table,
      databasePath: request.databasePath,
    };
  }
}

export class LocalDockerBackend extends BaseExecutionBackend {
  readonly name = 'local';
  private readonly cacheDir: string;
  private readonly pythonVenvDir: string;
  private prepared = false;

  constructor(rootDir: string, cacheDir: string) {
    super(rootDir);
    this.cacheDir = cacheDir;
    this.pythonVenvDir = path.join(cacheDir, 'python', '.venv');
  }

  async prepare(): Promise<void> {
    if (this.prepared) {
      return;
    }

    await fs.mkdir(path.join(this.cacheDir, 'python'), { recursive: true });
    const pythonBin = path.join(this.pythonVenvDir, 'bin', 'python');
    try {
      await fs.access(pythonBin);
    } catch {
      await runLocalCommand(`uv venv ${shellQuote(this.pythonVenvDir)}`, this.rootDir);
      await runLocalCommand(
        `uv pip install --python ${shellQuote(pythonBin)} duckdb pandas pyarrow`,
        this.rootDir,
      );
    }
    this.prepared = true;
  }

  async runShell(command: string, options: { cwd?: string; inputPaths?: string[]; outputPaths?: string[] } = {}): Promise<BackendCommandResult> {
    const cwd = options.cwd ? resolvePath(this.rootDir, options.cwd) : this.rootDir;
    const result = await runLocalCommand(command, cwd);
    const generatedFiles = await this.collectGeneratedFiles(options.outputPaths ?? []);
    return {
      backend: this.name,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      generatedFiles,
      command,
    };
  }

  async runPythonScript(request: PythonScriptRequest): Promise<BackendCommandResult> {
    await this.prepare();
    const cwd = request.cwd ? resolvePath(this.rootDir, request.cwd) : this.rootDir;
    const pythonBin = path.join(this.pythonVenvDir, 'bin', 'python');
    const scriptPath = request.scriptPath
      ? resolvePath(this.rootDir, request.scriptPath)
      : await this.writeInlineScript(request.script ?? '');
    const args = (request.args ?? []).map(shellQuote).join(' ');
    const command = `${shellQuote(pythonBin)} ${shellQuote(scriptPath)}${args ? ` ${args}` : ''}`;
    const result = await runLocalCommand(command, cwd);
    const generatedFiles = await this.collectGeneratedFiles(request.outputPaths ?? []);
    return {
      backend: this.name,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      generatedFiles,
      command,
      metadata: {
        scriptPath: path.relative(this.rootDir, scriptPath),
      },
    };
  }

  private async writeInlineScript(source: string): Promise<string> {
    const scriptDir = path.join(this.cacheDir, 'python', 'scripts');
    await fs.mkdir(scriptDir, { recursive: true });
    const targetPath = path.join(scriptDir, `inline-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.py`);
    await fs.writeFile(targetPath, source, 'utf8');
    return targetPath;
  }

  private async collectGeneratedFiles(outputPaths: string[]): Promise<string[]> {
    const generated: string[] = [];
    for (const candidate of outputPaths) {
      const absolutePath = resolvePath(this.rootDir, candidate);
      try {
        await fs.access(absolutePath);
        generated.push(path.relative(this.rootDir, absolutePath));
      } catch {
        // ignore missing outputs; verifier will surface them if required
      }
    }
    return generated;
  }
}

export class E2BBackend extends BaseExecutionBackend {
  readonly name = 'e2b';
  private readonly cacheDir: string;
  private readonly apiKey: string;
  private readonly templateId?: string;
  private sandbox?: any;
  private prepared = false;
  private readonly remoteRoot = '/home/user/workspace';

  constructor(rootDir: string, cacheDir: string, apiKey: string, templateId?: string) {
    super(rootDir);
    this.cacheDir = cacheDir;
    this.apiKey = apiKey;
    this.templateId = templateId;
  }

  async prepare(): Promise<void> {
    if (this.prepared) {
      return;
    }
    const module = await import('@e2b/code-interpreter');
    const Sandbox = (module as { Sandbox?: any }).Sandbox;
    if (!Sandbox) {
      throw new Error('E2B Sandbox export is not available.');
    }
    this.sandbox = await Sandbox.create({
      apiKey: this.apiKey,
      template: this.templateId,
    });
    await this.sandbox.commands.run(`mkdir -p ${shellQuote(this.remoteRoot)}`);
    await this.sandbox.commands.run('python -m pip install duckdb pandas pyarrow');
    this.prepared = true;
  }

  async runShell(command: string, options: { cwd?: string; inputPaths?: string[]; outputPaths?: string[] } = {}): Promise<BackendCommandResult> {
    await this.prepare();
    await this.uploadInputs(options.inputPaths ?? []);
    const remoteCwd = this.remotePath(options.cwd ?? '.');
    const result = await this.sandbox.commands.run(command, { cwd: remoteCwd });
    const generatedFiles = await this.downloadOutputs(options.outputPaths ?? []);
    return {
      backend: this.name,
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
      generatedFiles,
      command,
    };
  }

  async runPythonScript(request: PythonScriptRequest): Promise<BackendCommandResult> {
    await this.prepare();
    await this.uploadInputs(request.inputPaths ?? []);
    const remoteCwd = this.remotePath(request.cwd ?? '.');
    let remoteScriptPath: string;
    if (request.scriptPath) {
      const localScriptPath = resolvePath(this.rootDir, request.scriptPath);
      remoteScriptPath = this.remotePath(request.scriptPath);
      await this.ensureRemoteDir(path.posix.dirname(remoteScriptPath));
      const content = await fs.readFile(localScriptPath);
      await this.sandbox.files.write(remoteScriptPath, content);
    } else {
      remoteScriptPath = `${remoteCwd}/inline-${Date.now().toString(36)}.py`;
      await this.sandbox.files.write(remoteScriptPath, request.script ?? '');
    }
    const args = (request.args ?? []).map(shellQuote).join(' ');
    const result = await this.sandbox.commands.run(`python ${shellQuote(remoteScriptPath)}${args ? ` ${args}` : ''}`, {
      cwd: remoteCwd,
    });
    const generatedFiles = await this.downloadOutputs(request.outputPaths ?? []);
    return {
      backend: this.name,
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
      generatedFiles,
      command: `python ${remoteScriptPath}`,
      metadata: {
        scriptPath: remoteScriptPath,
      },
    };
  }

  async close(): Promise<void> {
    if (this.sandbox && typeof this.sandbox.kill === 'function') {
      await this.sandbox.kill();
    }
    this.sandbox = undefined;
    this.prepared = false;
  }

  private remotePath(candidate: string): string {
    const normalized = candidate === '.' ? '' : candidate.replace(/^\.\/+/, '');
    return normalized ? path.posix.join(this.remoteRoot, normalized) : this.remoteRoot;
  }

  private async ensureRemoteDir(directory: string): Promise<void> {
    await this.sandbox.commands.run(`mkdir -p ${shellQuote(directory)}`);
  }

  private async uploadInputs(inputPaths: string[]): Promise<void> {
    for (const candidate of inputPaths) {
      const localPath = resolvePath(this.rootDir, candidate);
      const remotePath = this.remotePath(candidate);
      await this.ensureRemoteDir(path.posix.dirname(remotePath));
      const content = await fs.readFile(localPath);
      await this.sandbox.files.write(remotePath, content);
    }
  }

  private async downloadOutputs(outputPaths: string[]): Promise<string[]> {
    const generated: string[] = [];
    for (const candidate of outputPaths) {
      const remotePath = this.remotePath(candidate);
      const localPath = resolvePath(this.rootDir, candidate);
      const content = await this.sandbox.files.read(remotePath);
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, typeof content === 'string' ? content : Buffer.from(content));
      generated.push(path.relative(this.rootDir, localPath));
    }
    return generated;
  }
}

export interface BackendSelectionResult {
  backend: ExecutionBackend;
  selectionReason: string;
}

export function createBackendFactory(config: BackendConfig): {
  select(preferred: 'local' | 'e2b' | 'default', reason?: string): Promise<BackendSelectionResult>;
  close(): Promise<void>;
} {
  const local = new LocalDockerBackend(config.rootDir, config.cacheDir);
  const e2b = config.e2bApiKey ? new E2BBackend(config.rootDir, config.cacheDir, config.e2bApiKey, config.e2bTemplateId) : undefined;
  return {
    async select(preferred, reason) {
      if (preferred === 'e2b') {
        if (!e2b) {
          return { backend: local, selectionReason: 'E2B was requested but not configured; falling back to local backend.' };
        }
        return { backend: e2b, selectionReason: reason ?? 'Planner requested E2B backend.' };
      }
      if (preferred === 'default' && config.defaultBackend === 'e2b' && e2b) {
        return { backend: e2b, selectionReason: reason ?? 'Default backend is configured as E2B.' };
      }
      return { backend: local, selectionReason: reason ?? 'Using local backend.' };
    },
    async close() {
      await local.close?.();
      await e2b?.close?.();
    },
  };
}
