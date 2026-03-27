#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import {
  analyzeRepository,
  ensureParentDirectories,
  formatCheckReport,
  writeGovernanceEvidence,
} from './governance.mjs';

function parseArgs(argv) {
  const args = {
    command: argv[2] ?? 'dev',
    outputDir: null,
    timestamp: null,
  };
  for (let index = 3; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--output-dir') {
      args.outputDir = argv[index + 1] ? path.resolve(argv[index + 1]) : null;
      index += 1;
    } else if (current === '--timestamp') {
      args.timestamp = argv[index + 1] ?? null;
      index += 1;
    }
  }
  return args;
}

function printUsage() {
  console.log(
    [
      'Usage:',
      '  node packages/spec-tools/src/cli.mjs dev',
      '  node packages/spec-tools/src/cli.mjs governance-check',
      '  node packages/spec-tools/src/cli.mjs governance-evidence [--timestamp YYYYMMDDTHHMMSSZ]',
      '  node packages/spec-tools/src/cli.mjs requirement-register',
      '  node packages/spec-tools/src/cli.mjs traceability-matrix',
      '  node packages/spec-tools/src/cli.mjs expand-routes',
      '  node packages/spec-tools/src/cli.mjs scan-ids',
      '',
      'Root npm wrappers:',
      '  npm run governance:check',
      '  npm run governance:evidence',
    ].join('\n'),
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const repoRoot = process.cwd();

  await ensureParentDirectories(repoRoot);

  switch (args.command) {
    case 'dev': {
      const analysis = await analyzeRepository(repoRoot);
      console.log('Phase 00 governance workspace ready.');
      console.log(formatCheckReport(analysis));
      return;
    }
    case 'build':
    case 'governance-check': {
      const analysis = await analyzeRepository(repoRoot);
      console.log(formatCheckReport(analysis));
      if (!analysis.valid) {
        process.exitCode = 1;
      }
      return;
    }
    case 'governance-evidence': {
      const result = await writeGovernanceEvidence(repoRoot, { timestamp: args.timestamp });
      console.log(`Wrote EVID-GOV-001 artifacts to ${path.relative(repoRoot, result.evidenceRoot)}`);
      console.log(formatCheckReport(result.analysis));
      if (!result.analysis.valid) {
        process.exitCode = 1;
      }
      return;
    }
    case 'requirement-register': {
      const analysis = await analyzeRepository(repoRoot);
      console.log(JSON.stringify(analysis.requirementRegister, null, 2));
      if (!analysis.valid) {
        process.exitCode = 1;
      }
      return;
    }
    case 'traceability-matrix': {
      const analysis = await analyzeRepository(repoRoot);
      console.log(JSON.stringify(analysis.traceabilityMatrix, null, 2));
      if (!analysis.valid) {
        process.exitCode = 1;
      }
      return;
    }
    case 'expand-routes': {
      const analysis = await analyzeRepository(repoRoot);
      console.log(JSON.stringify(analysis.wildcardRouteExpansion, null, 2));
      if (!analysis.valid) {
        process.exitCode = 1;
      }
      return;
    }
    case 'scan-ids': {
      const analysis = await analyzeRepository(repoRoot);
      console.log(
        JSON.stringify(
          analysis.definitions.map((definition) => ({
            id: definition.id,
            type: definition.type,
            file: definition.file,
            line: definition.line,
          })),
          null,
          2,
        ),
      );
      if (!analysis.valid) {
        process.exitCode = 1;
      }
      return;
    }
    case 'help':
    case '--help':
    case '-h': {
      printUsage();
      return;
    }
    default: {
      console.error(`Unknown command: ${args.command}`);
      printUsage();
      process.exitCode = 1;
    }
  }
}

await main();
