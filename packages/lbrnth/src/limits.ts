/** Hard ceilings can only be reduced by hosts. Keep this synchronous SDK bounded. */
export const DEFAULT_LIMITS = Object.freeze({
  organizations: 256, repositoriesPerOrg: 100, membersPerOrg: 1000,
  commitsPerRepository: 10000, refsPerRepository: 1000, pathsPerCommit: 10000,
  auditEntriesPerOrg: 50000, orgBytes: 32 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024, operationsPerMinute: 240,
});
export type LabyrinthLimits = { [K in keyof typeof DEFAULT_LIMITS]: number };
export const MAX_SNAPSHOT_FILE_BYTES = 192 * 1024 * 1024;
