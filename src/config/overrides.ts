import { existsSync, readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { ClassifyOverride } from '../core/classify.js';
import { configSchema, RawConfig, RawOverride } from './schema.js';

export interface CompiledConfig {
  overrides: Map<string, ClassifyOverride>;
  isExcluded: (repoFullName: string) => boolean;
}

const EMPTY_CONFIG: RawConfig = { overrides: [], excludeRepos: [] };

/** Validates the parsed YAML against the schema. Throws with a readable
 * message on invalid config — a malformed convoy.yaml should fail loudly at
 * boot, not silently fall back to "no overrides" and misclassify deploys. */
export function parseConfig(raw: unknown): RawConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid convoy.yaml:\n${issues}`);
  }
  return result.data;
}

export function compileConfig(raw: RawConfig): CompiledConfig {
  const overrides = new Map<string, ClassifyOverride>();
  for (const entry of raw.overrides) {
    overrides.set(entry.repo, compileOverride(entry));
  }

  const excludePatterns = raw.excludeRepos.map(globToRegExp);
  // A pattern like "test-*" is meant to describe a repo *name*, not a full
  // "owner/repo" path — match against both so "test-*" and "myorg/test-*"
  // both work as people would expect.
  const isExcluded = (repoFullName: string): boolean => {
    const bareName = repoFullName.split('/').pop() ?? repoFullName;
    return excludePatterns.some((re) => re.test(repoFullName) || re.test(bareName));
  };

  return { overrides, isExcluded };
}

function compileOverride(entry: RawOverride): ClassifyOverride {
  switch (entry.strategy) {
    case 'branch':
      return { strategy: 'branch', deployBranches: entry.deployBranches };
    case 'workflow-name':
      return { strategy: 'workflow-name', deployWorkflows: entry.deployWorkflows };
    case 'tag-pattern': {
      let tagPattern: RegExp;
      try {
        tagPattern = new RegExp(entry.tagPattern);
      } catch (err) {
        throw new Error(
          `Invalid convoy.yaml: overrides entry for "${entry.repo}" has an invalid tagPattern regex: ${
            (err as Error).message
          }`,
        );
      }
      return { strategy: 'tag-pattern', tagPattern };
    }
  }
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

/** Reads and compiles convoy.yaml from disk. A missing file is not an error
 * — the README documents Convoy working with sensible defaults with no
 * config file at all — but an existing, malformed file fails fast. */
export function loadConfig(path: string): CompiledConfig {
  if (!existsSync(path)) {
    return compileConfig(EMPTY_CONFIG);
  }
  const raw = parseYaml(readFileSync(path, 'utf8'));
  return compileConfig(parseConfig(raw));
}
