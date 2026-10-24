import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface TerminalActionFallbackContext {
  gitRepository: boolean;
  testEntrypoint: boolean;
}

const TEST_ENTRY_FILES = [
  'vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs',
  'jest.config.ts', 'jest.config.js', 'jest.config.mts', 'jest.config.mjs',
  'pytest.ini', 'tox.ini', 'playwright.config.ts', 'playwright.config.js',
  'cypress.config.ts', 'cypress.config.js',
];

export function detectTerminalActionFallbackContext(cwd: string | undefined): TerminalActionFallbackContext {
  if (!cwd || !isAbsolute(cwd)) return { gitRepository: false, testEntrypoint: false };
  const ancestors = ancestorDirectories(resolve(cwd));
  return {
    gitRepository: isGitWorktree(cwd),
    testEntrypoint: ancestors.some(hasTestEntrypoint),
  };
}

function isGitWorktree(cwd: string): boolean {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
      maxBuffer: 1024,
    }).trim() === 'true';
  } catch {
    return false;
  }
}

function ancestorDirectories(start: string): string[] {
  const directories = [start];
  let current = start;
  while (true) {
    const parent = dirname(current);
    if (parent === current) return directories;
    directories.push(parent);
    current = parent;
  }
}

function hasTestEntrypoint(directory: string): boolean {
  if (TEST_ENTRY_FILES.some((name) => existsSync(join(directory, name)))) return true;
  if (hasPackageTestScript(directory)) return true;
  if (hasMakeTestTarget(directory)) return true;
  if (existsSync(join(directory, 'Cargo.toml'))) return true;
  if (existsSync(join(directory, 'go.mod')) && hasTestDirectory(directory)) return true;
  return ['tests', 'test', '__tests__'].some((name) => hasEntries(join(directory, name)));
}

function hasPackageTestScript(directory: string): boolean {
  try {
    const packageJson = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    return Object.entries(packageJson.scripts ?? {}).some(([name, command]) =>
      (name === 'test' || name.startsWith('test:')) && typeof command === 'string' && Boolean(command.trim()),
    );
  } catch {
    return false;
  }
}

function hasMakeTestTarget(directory: string): boolean {
  try {
    return /^\s*test\s*:/m.test(readFileSync(join(directory, 'Makefile'), 'utf8'));
  } catch {
    return false;
  }
}

function hasTestDirectory(directory: string): boolean {
  return ['tests', 'test', '__tests__'].some((name) => hasEntries(join(directory, name)));
}

function hasEntries(path: string): boolean {
  try {
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}
