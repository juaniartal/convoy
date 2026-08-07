import { describe, expect, it } from 'vitest';
import { classifyRun } from '../src/core/classify.js';
import { compileConfig, parseConfig } from '../src/config/overrides.js';

describe('parseConfig', () => {
  it('accepts a config with no overrides or excludes', () => {
    expect(parseConfig({})).toEqual({ overrides: [], excludeRepos: [] });
  });

  it('accepts a valid mixed-strategy config', () => {
    const raw = {
      overrides: [
        { repo: 'org/a', strategy: 'branch', deployBranches: ['production'] },
        { repo: 'org/b', strategy: 'tag-pattern', tagPattern: '^release-.*$' },
        { repo: 'org/c', strategy: 'workflow-name', deployWorkflows: ['Deploy'] },
      ],
      excludeRepos: ['*-archive'],
    };
    expect(() => parseConfig(raw)).not.toThrow();
  });

  it('rejects an override missing required fields for its strategy', () => {
    const raw = { overrides: [{ repo: 'org/a', strategy: 'branch' }] };
    expect(() => parseConfig(raw)).toThrow(/Invalid convoy.yaml/);
  });

  it('rejects an unknown strategy', () => {
    const raw = { overrides: [{ repo: 'org/a', strategy: 'made-up' }] };
    expect(() => parseConfig(raw)).toThrow(/Invalid convoy.yaml/);
  });
});

describe('compileConfig', () => {
  it('compiles a tag-pattern override into a usable RegExp', () => {
    const compiled = compileConfig(
      parseConfig({
        overrides: [{ repo: 'org/a', strategy: 'tag-pattern', tagPattern: '^release-.*$' }],
      }),
    );
    const override = compiled.overrides.get('org/a');
    expect(override).toBeDefined();
    expect(
      classifyRun({ event: 'push', headBranch: 'release-2026-08', workflowName: 'CI' }, override),
    ).toBe('deploy');
  });

  it('throws a clear error for an invalid tagPattern regex', () => {
    const raw = parseConfig({
      overrides: [{ repo: 'org/a', strategy: 'tag-pattern', tagPattern: '(unclosed' }],
    });
    expect(() => compileConfig(raw)).toThrow(/invalid tagPattern regex/);
  });

  it('compiles excludeRepos glob patterns into working matchers', () => {
    const compiled = compileConfig(parseConfig({ excludeRepos: ['*-archive', 'test-*'] }));
    expect(compiled.isExcluded('org/legacy-archive')).toBe(true);
    expect(compiled.isExcluded('org/test-fixtures')).toBe(true);
    expect(compiled.isExcluded('org/production-service')).toBe(false);
  });
});
