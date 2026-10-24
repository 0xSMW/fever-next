/** Tooling exports each physical table once; compatibility aliases stay in schema.ts. */
export {
  installation, owners, feverCredentials, authRecoveryTokens, authRateLimits,
  readerPreferences, readerViewState, sharingServices, favicons, groups, feeds,
  feedGroups, feedCredentials, feedFetchState, items, itemIdentityAliases,
  linkOccurrences, blacklistRules, refreshJobs, jobFeedResults, workerHeartbeats,
  stateOperations, ingestQuarantine, migrationRuns, migrationIssues,
  maintenanceBackups, maintenanceChallenges,
} from "./schema";
