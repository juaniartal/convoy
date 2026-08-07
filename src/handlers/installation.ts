import { Context } from 'probot';
import { StateStore } from '../core/state.js';

/**
 * Keeps StateStore's repo list in sync with what the GitHub App can actually
 * see. Installations can be scoped to "selected repositories," not just
 * "all repos" — these events are how Convoy learns about repos being
 * added/removed from that scope without waiting for the next reconciliation
 * pass. `default_branch` isn't present on these payloads' repo objects, so a
 * placeholder is used here and corrected by the next reconciliation pass.
 */
export function handleInstallationCreated(state: StateStore) {
  return async (context: Context<'installation.created'>): Promise<void> => {
    for (const repo of context.payload.repositories ?? []) {
      state.upsertRepo({
        id: repo.id,
        fullName: repo.full_name,
        private: repo.private,
        defaultBranch: 'main',
      });
    }
  };
}

export function handleInstallationDeleted(state: StateStore) {
  return async (context: Context<'installation.deleted'>): Promise<void> => {
    for (const repo of context.payload.repositories ?? []) {
      state.removeRepo(repo.full_name);
    }
  };
}

export function handleInstallationRepositoriesAdded(state: StateStore) {
  return async (context: Context<'installation_repositories.added'>): Promise<void> => {
    for (const repo of context.payload.repositories_added) {
      state.upsertRepo({
        id: repo.id,
        fullName: repo.full_name,
        private: repo.private,
        defaultBranch: 'main',
      });
    }
  };
}

export function handleInstallationRepositoriesRemoved(state: StateStore) {
  return async (context: Context<'installation_repositories.removed'>): Promise<void> => {
    for (const repo of context.payload.repositories_removed) {
      state.removeRepo(repo.full_name);
    }
  };
}
