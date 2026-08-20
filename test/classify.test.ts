import { describe, expect, it } from 'vitest';
import { classifyRun } from '../src/core/classify.js';

describe('classifyRun (default heuristic, no override)', () => {
  it('classifies a release-triggered run as a deploy', () => {
    expect(classifyRun({ event: 'release', headBranch: 'v1.2.3', workflowName: 'Deploy' })).toBe(
      'deploy',
    );
  });

  it('classifies a push to a semver-shaped tag as a deploy', () => {
    expect(classifyRun({ event: 'push', headBranch: 'v1.2.3', workflowName: 'CI' })).toBe('deploy');
    expect(classifyRun({ event: 'push', headBranch: '1.2.3', workflowName: 'CI' })).toBe('deploy');
    expect(
      classifyRun({ event: 'push', headBranch: 'v1.4.22-hotfix-20260731', workflowName: 'CI' }),
    ).toBe('deploy');
  });

  it('classifies a push to a normal branch as a pipeline', () => {
    for (const branch of ['main', 'qa', 'feature/POS-1234', 'bugfix/POS-5975']) {
      expect(classifyRun({ event: 'push', headBranch: branch, workflowName: 'CI' })).toBe(
        'pipeline',
      );
    }
  });

  it('classifies workflow_dispatch and schedule runs as pipelines', () => {
    expect(
      classifyRun({ event: 'workflow_dispatch', headBranch: 'main', workflowName: 'CI' }),
    ).toBe('pipeline');
    expect(classifyRun({ event: 'schedule', headBranch: 'main', workflowName: 'Nightly' })).toBe(
      'pipeline',
    );
  });

  it('treats a null head_branch as a pipeline rather than throwing', () => {
    expect(classifyRun({ event: 'push', headBranch: null, workflowName: 'CI' })).toBe('pipeline');
  });

  it('still matches build/pre-release metadata correctly after the ReDoS fix', () => {
    expect(classifyRun({ event: 'push', headBranch: '1.2.3+build.5', workflowName: 'CI' })).toBe(
      'deploy',
    );
    expect(
      classifyRun({ event: 'push', headBranch: '1.2.3-beta+build5', workflowName: 'CI' }),
    ).toBe('deploy');
  });

  // headBranch is attacker-influenceable (anyone who can push a tag/branch
  // to a repo this App is installed on) -- a naive version of this regex
  // was catastrophically backtracking on strings with many dashes (CodeQL
  // js/redos). This would hang for minutes on the old pattern; the fixed
  // one rejects it near-instantly. The test's own timeout is what actually
  // catches a regression, not the assertion itself.
  it('rejects a long run of dashes without catastrophic backtracking', () => {
    const malicious = `v1.0.0${'-'.repeat(50)}!`;
    const start = Date.now();
    expect(classifyRun({ event: 'push', headBranch: malicious, workflowName: 'CI' })).toBe(
      'pipeline',
    );
    expect(Date.now() - start).toBeLessThan(100);
  });
});

describe('classifyRun (with an override)', () => {
  it('branch strategy: deploys only from the configured branches', () => {
    const override = { strategy: 'branch' as const, deployBranches: ['production'] };
    expect(
      classifyRun({ event: 'push', headBranch: 'production', workflowName: 'CI' }, override),
    ).toBe('deploy');
    expect(classifyRun({ event: 'push', headBranch: 'main', workflowName: 'CI' }, override)).toBe(
      'pipeline',
    );
  });

  it('tag-pattern strategy: matches a custom regex instead of the semver default', () => {
    const override = { strategy: 'tag-pattern' as const, tagPattern: /^release-.*$/ };
    expect(
      classifyRun({ event: 'push', headBranch: 'release-2026-08', workflowName: 'CI' }, override),
    ).toBe('deploy');
    // A normal semver tag no longer counts once an override is present for this repo.
    expect(classifyRun({ event: 'push', headBranch: 'v1.2.3', workflowName: 'CI' }, override)).toBe(
      'pipeline',
    );
  });

  it('workflow-name strategy: matches by workflow name regardless of ref', () => {
    const override = { strategy: 'workflow-name' as const, deployWorkflows: ['Deploy to Prod'] };
    expect(
      classifyRun({ event: 'push', headBranch: 'main', workflowName: 'Deploy to Prod' }, override),
    ).toBe('deploy');
    expect(
      classifyRun({ event: 'push', headBranch: 'main', workflowName: 'Build and Test' }, override),
    ).toBe('pipeline');
  });

  it('an override fully replaces the default heuristic rather than adding to it', () => {
    // Without an override this would be a deploy (release event) — the branch
    // override for this repo says otherwise, and should win completely.
    const override = { strategy: 'branch' as const, deployBranches: ['production'] };
    expect(
      classifyRun({ event: 'release', headBranch: 'v1.2.3', workflowName: 'CI' }, override),
    ).toBe('pipeline');
  });
});
