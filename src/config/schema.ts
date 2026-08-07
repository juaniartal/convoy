import { z } from 'zod';

const branchOverride = z.object({
  repo: z.string().min(1),
  strategy: z.literal('branch'),
  deployBranches: z.array(z.string().min(1)).min(1),
});

const tagPatternOverride = z.object({
  repo: z.string().min(1),
  strategy: z.literal('tag-pattern'),
  tagPattern: z.string().min(1),
});

const workflowNameOverride = z.object({
  repo: z.string().min(1),
  strategy: z.literal('workflow-name'),
  deployWorkflows: z.array(z.string().min(1)).min(1),
});

export const overrideSchema = z.discriminatedUnion('strategy', [
  branchOverride,
  tagPatternOverride,
  workflowNameOverride,
]);

export const configSchema = z.object({
  overrides: z.array(overrideSchema).default([]),
  excludeRepos: z.array(z.string().min(1)).default([]),
});

export type RawConfig = z.infer<typeof configSchema>;
export type RawOverride = z.infer<typeof overrideSchema>;
