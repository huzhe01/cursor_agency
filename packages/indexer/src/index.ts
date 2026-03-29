import chokidar from 'chokidar';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface TextEmbedder {
  embedTexts(texts: string[]): Promise<number[][]>;
}

export interface IndexProviderOptions {
  rootDir: string;
  dbPath: string;
  embedder?: TextEmbedder;
}

export interface BuildStats {
  scannedFiles: number;
  indexedFiles: number;
  deletedFiles: number;
  chunkCount: number;
  usedEmbeddings: boolean;
}

export interface SearchResult {
  path: string;
  chunkId: string;
  excerpt: string;
  score: number;
  startLine: number;
  endLine: number;
  source: 'fts' | 'vector';
}

interface ChunkRecord {
  id: string;
  path: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  content: string;
  embedding: number[] | null;
}

const IGNORE_DIRS = new Set([
  '.agency',
  '.cache',
  '.devcontainer',
  '.git',
  '.next',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

const TEXT_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.css',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.mjs',
  '.md',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function isIgnoredDir(name: string): boolean {
  return IGNORE_DIRS.has(name);
}

function isLikelyText(filePath: string, buffer: Buffer): boolean {
  const ext = path.extname(filePath);
  if (TEXT_EXTENSIONS.has(ext)) {
    return true;
  }

  return !buffer.includes(0);
}

function listFiles(rootDir: string): string[] {
  const queue = [rootDir];
  const files: string[] = [];

  while (queue.length > 0) {
    const currentDir = queue.pop()!;
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && !['.env.example', '.env.local'].includes(entry.name)) {
        if (entry.isDirectory() && isIgnoredDir(entry.name)) {
          continue;
        }
      }

      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!isIgnoredDir(entry.name)) {
          queue.push(fullPath);
        }
        continue;
      }

      files.push(fullPath);
    }
  }

  return files;
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function chunkText(relativePath: string, content: string): ChunkRecord[] {
  const lines = content.split(/\r?\n/);
  const chunks: ChunkRecord[] = [];
  const maxLines = 80;
  const maxChars = 2000;

  let startLine = 1;
  let chunkIndex = 0;

  while (startLine <= lines.length) {
    let endLine = Math.min(lines.length, startLine + maxLines - 1);
    let slice = lines.slice(startLine - 1, endLine).join('\n');

    while (slice.length > maxChars && endLine > startLine) {
      endLine -= 5;
      slice = lines.slice(startLine - 1, endLine).join('\n');
    }

    const trimmed = slice.trim();
    if (trimmed.length > 0) {
      const id = sha256(`${relativePath}:${chunkIndex}:${startLine}:${endLine}:${trimmed}`);
      chunks.push({
        id,
        path: relativePath,
        chunkIndex,
        startLine,
        endLine,
        content: trimmed,
        embedding: null,
      });
      chunkIndex += 1;
    }

    startLine = endLine + 1;
  }

  return chunks;
}

function sanitizeFtsQuery(query: string): string {
  const tokens = query.match(/[A-Za-z0-9_./-]+/g) ?? [];
  if (tokens.length === 0) {
    return '""';
  }

  return tokens.map((token) => `"${token.replace(/"/g, '')}"`).join(' OR ');
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export class SQLiteIndexProvider {
  private readonly rootDir: string;
  private readonly dbPath: string;
  private readonly embedder?: TextEmbedder;
  private readonly db: Database.Database;

  constructor(options: IndexProviderOptions) {
    this.rootDir = options.rootDir;
    this.dbPath = options.dbPath;
    this.embedder = options.embedder;
    ensureParentDir(this.dbPath);
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        mtime_ms INTEGER NOT NULL,
        size INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
        chunk_id UNINDEXED,
        path,
        content
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
    `);
  }

  private ingestFile(absolutePath: string): ChunkRecord[] | null {
    const stats = fs.statSync(absolutePath);
    if (!stats.isFile()) {
      return null;
    }

    const buffer = fs.readFileSync(absolutePath);
    if (!isLikelyText(absolutePath, buffer)) {
      return null;
    }

    const content = buffer.toString('utf8');
    const relativePath = path.relative(this.rootDir, absolutePath);
    const fileHash = sha256(content);
    const currentFile = this.db
      .prepare<[string], { hash: string }>('SELECT hash FROM files WHERE path = ?')
      .get(relativePath);

    if (currentFile?.hash === fileHash) {
      return [];
    }

    const chunks = chunkText(relativePath, content);
    this.db.prepare('DELETE FROM chunk_fts WHERE path = ?').run(relativePath);
    this.db.prepare('DELETE FROM chunks WHERE path = ?').run(relativePath);

    const insertChunk = this.db.prepare(`
      INSERT INTO chunks (id, path, chunk_index, start_line, end_line, content, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = this.db.prepare(`
      INSERT INTO chunk_fts (chunk_id, path, content)
      VALUES (?, ?, ?)
    `);

    const insertFile = this.db.prepare(`
      INSERT INTO files (path, hash, mtime_ms, size, indexed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        hash = excluded.hash,
        mtime_ms = excluded.mtime_ms,
        size = excluded.size,
        indexed_at = excluded.indexed_at
    `);

    const transaction = this.db.transaction((records: ChunkRecord[]) => {
      for (const record of records) {
        insertChunk.run(
          record.id,
          record.path,
          record.chunkIndex,
          record.startLine,
          record.endLine,
          record.content,
          record.embedding ? JSON.stringify(record.embedding) : null,
        );
        insertFts.run(record.id, record.path, record.content);
      }

      insertFile.run(relativePath, fileHash, Math.trunc(stats.mtimeMs), stats.size, Date.now());
    });

    transaction(chunks);
    return chunks;
  }

  async build(): Promise<BuildStats> {
    const files = listFiles(this.rootDir);
    const trackedPaths = new Set<string>();
    let indexedFiles = 0;
    let chunkCount = 0;

    for (const absolutePath of files) {
      const relativePath = path.relative(this.rootDir, absolutePath);
      trackedPaths.add(relativePath);
      const chunks = this.ingestFile(absolutePath);
      if (chunks && chunks.length > 0) {
        indexedFiles += 1;
        chunkCount += chunks.length;
      }
    }

    const existingPaths = this.db.prepare<[], { path: string }>('SELECT path FROM files').all();
    let deletedFiles = 0;
    for (const row of existingPaths) {
      if (!trackedPaths.has(row.path)) {
        this.db.prepare('DELETE FROM files WHERE path = ?').run(row.path);
        this.db.prepare('DELETE FROM chunks WHERE path = ?').run(row.path);
        this.db.prepare('DELETE FROM chunk_fts WHERE path = ?').run(row.path);
        deletedFiles += 1;
      }
    }

    let usedEmbeddings = Boolean(this.embedder);
    if (this.embedder) {
      try {
        await this.populateMissingEmbeddings();
      } catch {
        usedEmbeddings = false;
      }
    }

    return {
      scannedFiles: files.length,
      indexedFiles,
      deletedFiles,
      chunkCount,
      usedEmbeddings,
    };
  }

  private async populateMissingEmbeddings(): Promise<void> {
    if (!this.embedder) {
      return;
    }

    const rows = this.db
      .prepare<[], { id: string; content: string }>('SELECT id, content FROM chunks WHERE embedding IS NULL ORDER BY path, chunk_index')
      .all();

    if (rows.length === 0) {
      return;
    }

    const update = this.db.prepare('UPDATE chunks SET embedding = ? WHERE id = ?');
    const batchSize = 32;

    for (let index = 0; index < rows.length; index += batchSize) {
      const batch = rows.slice(index, index + batchSize);
      const embeddings = await this.embedder.embedTexts(batch.map((row: { content: string }) => row.content));
      const transaction = this.db.transaction(() => {
        for (let innerIndex = 0; innerIndex < batch.length; innerIndex += 1) {
          update.run(JSON.stringify(embeddings[innerIndex]), batch[innerIndex].id);
        }
      });
      transaction();
    }
  }

  async search(query: string, limit = 8): Promise<SearchResult[]> {
    const lexicalResults = this.searchLexical(query, limit * 2);
    const merged = new Map<string, SearchResult>();

    for (const result of lexicalResults) {
      merged.set(result.chunkId, result);
    }

    if (this.embedder) {
      try {
        const semanticResults = await this.searchSemantic(query, limit * 2);
        for (const result of semanticResults) {
          const existing = merged.get(result.chunkId);
          if (!existing || result.score > existing.score) {
            merged.set(result.chunkId, result);
          }
        }
      } catch {
        // Fall back to lexical-only search when the embedding endpoint is unavailable.
      }
    }

    return [...merged.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  private searchLexical(query: string, limit: number): SearchResult[] {
    const ftsQuery = sanitizeFtsQuery(query);
    const rows = this.db
      .prepare<[string, number], {
        chunk_id: string;
        path: string;
        start_line: number;
        end_line: number;
        excerpt: string;
        score: number;
      }>(`
        SELECT
          chunks.id AS chunk_id,
          chunks.path AS path,
          chunks.start_line AS start_line,
          chunks.end_line AS end_line,
          snippet(chunk_fts, 2, '[', ']', ' ... ', 16) AS excerpt,
          bm25(chunk_fts) * -1.0 AS score
        FROM chunk_fts
        JOIN chunks ON chunks.id = chunk_fts.chunk_id
        WHERE chunk_fts MATCH ?
        ORDER BY score DESC
        LIMIT ?
      `)
      .all(ftsQuery, limit);

    return rows.map((row: {
      chunk_id: string;
      path: string;
      start_line: number;
      end_line: number;
      excerpt: string;
      score: number;
    }) => ({
      path: row.path,
      chunkId: row.chunk_id,
      excerpt: row.excerpt,
      score: row.score,
      startLine: row.start_line,
      endLine: row.end_line,
      source: 'fts',
    }));
  }

  private async searchSemantic(query: string, limit: number): Promise<SearchResult[]> {
    if (!this.embedder) {
      return [];
    }

    const [queryEmbedding] = await this.embedder.embedTexts([query]);
    const rows = this.db
      .prepare<[], {
        id: string;
        path: string;
        start_line: number;
        end_line: number;
        content: string;
        embedding: string;
      }>('SELECT id, path, start_line, end_line, content, embedding FROM chunks WHERE embedding IS NOT NULL')
      .all();

    return rows
      .map((row: {
        id: string;
        path: string;
        start_line: number;
        end_line: number;
        content: string;
        embedding: string;
      }) => ({
        path: row.path,
        chunkId: row.id,
        excerpt: row.content.slice(0, 280),
        score: cosineSimilarity(queryEmbedding, JSON.parse(row.embedding) as number[]),
        startLine: row.start_line,
        endLine: row.end_line,
        source: 'vector' as const,
      }))
      .sort((left: SearchResult, right: SearchResult) => right.score - left.score)
      .slice(0, limit);
  }

  async relatedFiles(query: string, limit = 5): Promise<string[]> {
    const matches = await this.search(query, limit * 2);
    const files = new Set<string>();
    for (const match of matches) {
      files.add(match.path);
      if (files.size >= limit) {
        break;
      }
    }
    return [...files];
  }

  async watch(onReindex?: (stats: BuildStats) => void): Promise<void> {
    const watcher = chokidar.watch(this.rootDir, {
      ignored: (targetPath) => {
        const relativePath = path.relative(this.rootDir, targetPath);
        return relativePath.split(path.sep).some((segment) => isIgnoredDir(segment));
      },
      ignoreInitial: true,
      persistent: true,
    });

    const rebuild = async (): Promise<void> => {
      const stats = await this.build();
      onReindex?.(stats);
    };

    let timer: NodeJS.Timeout | undefined;
    const schedule = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        void rebuild();
      }, 500);
    };

    watcher.on('add', schedule);
    watcher.on('change', schedule);
    watcher.on('unlink', schedule);

    return new Promise(() => {
      // Keep the process alive until the caller terminates it.
    });
  }

  close(): void {
    this.db.close();
  }
}
