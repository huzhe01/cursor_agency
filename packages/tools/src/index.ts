import { spawn } from 'node:child_process';
import { applyPatch, createTwoFilesPatch } from 'diff';
import fs from 'node:fs/promises';
import path from 'node:path';

export type ApprovalKind = 'read' | 'write' | 'shell';

export interface SearchIndexHit {
  path: string;
  excerpt: string;
  score: number;
  startLine: number;
  endLine: number;
  source: string;
}

export interface SearchIndexLike {
  search(query: string, limit?: number): Promise<SearchIndexHit[]>;
}

export interface SessionLike {
  captureOriginal(filePath: string): Promise<void>;
  renderDiff(targetPath?: string): Promise<string>;
  writeArtifact(name: string, content: string): Promise<string>;
}

export interface ToolExecutionResult {
  content: string;
  artifactPath?: string;
}

export interface ToolContext {
  rootDir: string;
  session: SessionLike;
  index: SearchIndexLike;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  approval: ApprovalKind;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult>;
}

function resolvePath(rootDir: string, target: string): string {
  const absolutePath = path.resolve(rootDir, target);
  const relativePath = path.relative(rootDir, absolutePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Path ${target} escapes the workspace root.`);
  }

  return absolutePath;
}

async function maybeArtifact(session: SessionLike, label: string, content: string): Promise<ToolExecutionResult> {
  if (content.length <= 4000) {
    return { content };
  }

  const artifactPath = await session.writeArtifact(label, content);
  return {
    content: `${content.slice(0, 1200)}\n\n[truncated] Full output stored at ${artifactPath}`,
    artifactPath,
  };
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function asString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Expected ${fieldName} to be a non-empty string.`);
  }

  return value;
}

function formatPatchInput(relativePath: string, current: string, patch: string): string {
  return patch.includes('--- ') && patch.includes('+++ ')
    ? patch
    : createTwoFilesPatch(relativePath, relativePath, current, patch, 'before', 'after');
}

async function runCommand(command: string, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
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

export function createDefaultTools(): ToolDefinition[] {
  return [
    {
      name: 'read_file',
      description: 'Read a file from the current workspace.',
      approval: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the repository root.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      async execute(args, context) {
        const target = resolvePath(context.rootDir, asString(args.path, 'path'));
        const content = await fs.readFile(target, 'utf8');
        return maybeArtifact(context.session, `read-${path.basename(target)}.txt`, content);
      },
    },
    {
      name: 'list_files',
      description: 'List files in the workspace, optionally under a relative directory.',
      approval: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional directory relative to the repository root.' },
        },
        additionalProperties: false,
      },
      async execute(args, context) {
        const directory = typeof args.path === 'string' ? resolvePath(context.rootDir, args.path) : context.rootDir;
        const { stdout, stderr, exitCode } = await runCommand(
          `find ${JSON.stringify(directory)} -maxdepth 3 -type f | sed "s#^${context.rootDir}/##" | sort`,
          context.rootDir,
        );
        const output = [`exit=${exitCode ?? 'null'}`, stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
        return maybeArtifact(context.session, 'list-files.txt', output);
      },
    },
    {
      name: 'search_code',
      description: 'Run a fast lexical search over the repository using ripgrep.',
      approval: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'ripgrep query string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async execute(args, context) {
        const query = asString(args.query, 'query');
        const { stdout, stderr, exitCode } = await runCommand(
          `rg -n --hidden --glob '!node_modules' --glob '!.git' --glob '!.agency' --glob '!.cache' --max-count 50 --color never ${JSON.stringify(query)} .`,
          context.rootDir,
        );
        const output = [`exit=${exitCode ?? 'null'}`, stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
        return maybeArtifact(context.session, 'search-code.txt', output);
      },
    },
    {
      name: 'read_multiple_files',
      description: 'Read several files in one call when comparing nearby code.',
      approval: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 8,
          },
        },
        required: ['paths'],
        additionalProperties: false,
      },
      async execute(args, context) {
        if (!Array.isArray(args.paths) || args.paths.length === 0) {
          throw new Error('Expected paths to be a non-empty array.');
        }
        const sections: string[] = [];
        for (const candidate of args.paths) {
          const target = resolvePath(context.rootDir, asString(candidate, 'paths[]'));
          const content = await fs.readFile(target, 'utf8');
          sections.push(`# ${path.relative(context.rootDir, target)}\n${content}`);
        }
        return maybeArtifact(context.session, 'read-multiple-files.txt', sections.join('\n\n'));
      },
    },
    {
      name: 'search_index',
      description: 'Search the local SQLite code index for semantically relevant chunks.',
      approval: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language or code query.' },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async execute(args, context) {
        const query = asString(args.query, 'query');
        const limit = typeof args.limit === 'number' ? args.limit : 8;
        const results = await context.index.search(query, limit);
        const content = results.length === 0
          ? 'No indexed matches found.'
          : results
              .map((result, index) => `${index + 1}. ${result.path}:${result.startLine}-${result.endLine} [${result.source}] score=${result.score.toFixed(3)}\n${result.excerpt}`)
              .join('\n\n');
        return maybeArtifact(context.session, 'search-index.txt', content);
      },
    },
    {
      name: 'write_patch',
      description: 'Modify or create a file using either search/replace or full overwrite mode.',
      approval: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the repository root.' },
          mode: { type: 'string', enum: ['replace', 'overwrite'] },
          search: { type: 'string' },
          replace: { type: 'string' },
          content: { type: 'string' },
          create_if_missing: { type: 'boolean' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      async execute(args, context) {
        const relativePath = asString(args.path, 'path');
        const mode = typeof args.mode === 'string' ? args.mode : 'replace';
        const createIfMissing = args.create_if_missing === true;
        const target = resolvePath(context.rootDir, relativePath);

        let current = '';
        let exists = true;
        try {
          current = await fs.readFile(target, 'utf8');
        } catch (error) {
          exists = false;
          if (!createIfMissing) {
            throw error;
          }
        }

        await context.session.captureOriginal(target);

        let nextContent: string;
        if (mode === 'overwrite') {
          nextContent = asString(args.content, 'content');
        } else {
          const search = asString(args.search, 'search');
          const replace = asString(args.replace, 'replace');
          if (!exists) {
            throw new Error(`Cannot replace content in missing file ${relativePath}. Use overwrite mode.`);
          }
          if (!current.includes(search)) {
            throw new Error(`Search string was not found in ${relativePath}.`);
          }
          nextContent = current.replace(search, replace);
        }

        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, nextContent, 'utf8');
        return {
          content: `Updated ${relativePath} using ${mode} mode.`,
        };
      },
    },
    {
      name: 'apply_unified_patch',
      description: 'Apply one or more unified diff patches. Supports dry_run for preview before write approval.',
      approval: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the repository root. Use with patch for single-file edits.' },
          patch: { type: 'string', description: 'Unified diff patch body for a single file.' },
          dry_run: { type: 'boolean', description: 'Validate and preview patch application without writing files.' },
          patches: {
            type: 'array',
            description: 'Optional multi-file patch list.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                patch: { type: 'string' },
              },
              required: ['path', 'patch'],
              additionalProperties: false,
            },
            minItems: 1,
            maxItems: 12,
          },
        },
        additionalProperties: false,
      },
      async execute(args, context) {
        const dryRun = args.dry_run === true;
        const patchInputs = Array.isArray(args.patches)
          ? args.patches.map((entry, index) => ({
              path: asString((entry as Record<string, unknown>).path, `patches[${index}].path`),
              patch: asString((entry as Record<string, unknown>).patch, `patches[${index}].patch`),
            }))
          : [{
              path: asString(args.path, 'path'),
              patch: asString(args.patch, 'patch'),
            }];
        if (patchInputs.length === 0) {
          throw new Error('Expected either path+patch or a non-empty patches array.');
        }

        const diffs: string[] = [];
        const updatedFiles: string[] = [];
        for (const input of patchInputs) {
          const target = resolvePath(context.rootDir, input.path);
          const current = await fs.readFile(target, 'utf8');
          const patchText = formatPatchInput(input.path, current, input.patch);
          const next = applyPatch(normalizeLineEndings(current), normalizeLineEndings(patchText));
          if (next === false) {
            throw new Error(`Patch could not be applied cleanly to ${input.path}.`);
          }

          diffs.push(createTwoFilesPatch(input.path, input.path, current, next, 'before', dryRun ? 'preview' : 'after'));
          updatedFiles.push(input.path);
          if (!dryRun) {
            await context.session.captureOriginal(target);
            await fs.writeFile(target, next, 'utf8');
          }
        }

        const combinedDiff = diffs.join('\n');
        const action = dryRun ? 'Validated' : 'Applied';
        const artifact = await context.session.writeArtifact(
          dryRun ? 'patch-preview.patch' : 'patch-apply.patch',
          combinedDiff,
        );
        return {
          content: `${action} unified patch for ${updatedFiles.length} file(s): ${updatedFiles.join(', ')}.\nPreview: ${artifact}`,
          artifactPath: artifact,
        };
      },
    },
    {
      name: 'run_shell',
      description: 'Run a shell command from the repository root.',
      approval: 'shell',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
        },
        required: ['command'],
        additionalProperties: false,
      },
      async execute(args, context) {
        const command = asString(args.command, 'command');
        const result = await runCommand(command, context.rootDir);
        const output = [`$ ${command}`, `exit=${result.exitCode ?? 'null'}`, result.stdout.trim(), result.stderr.trim()]
          .filter(Boolean)
          .join('\n');
        return maybeArtifact(context.session, 'shell-output.txt', output);
      },
    },
    {
      name: 'read_diff',
      description: 'Read the diff for the files touched during this session.',
      approval: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional path relative to the repository root.' },
        },
        additionalProperties: false,
      },
      async execute(args, context) {
        const target = typeof args.path === 'string' ? resolvePath(context.rootDir, args.path) : undefined;
        const diff = await context.session.renderDiff(target);
        return maybeArtifact(context.session, 'workspace-diff.patch', diff || 'No changes captured in this session.');
      },
    },
  ];
}
