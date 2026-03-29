import { ensureWorkspaceDirs, loadConfig, renderDoctorReport } from '@agency/core';
import { SQLiteIndexProvider } from '@agency/indexer';

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
  } finally {
    index.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
