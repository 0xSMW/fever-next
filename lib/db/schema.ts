import { sql } from "drizzle-orm";
import {
  bigint, boolean, check, customType, foreignKey, index, integer, jsonb,
  pgTable, primaryKey, smallint, text, timestamp, unique, uniqueIndex, varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { Section } from "../contracts";

/** IDs are bigint on disk and range-constrained to the exact JSON integer range. */
const id = (name = "id") => bigint(name, { mode: "number" }).primaryKey().generatedByDefaultAsIdentity();
const ref = (name: string) => bigint(name, { mode: "number" });
const epoch = (name: string) => bigint(name, { mode: "number" });
const auditTime = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const digest = (name: string) => varchar(name, { length: 64 });
const safe = (name: string, column: AnyPgColumn, min = 0, max = 9007199254740991) => check(name, sql`${column} between ${sql.raw(String(min))} and ${sql.raw(String(max))}`);
const crc = (name: string, column: AnyPgColumn) => safe(name, column, 0, 4294967295);
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
export type JsonObject = Record<string, unknown>;

export const installation = pgTable("installation", {
  id: smallint("id").primaryKey().default(1), schemaVersion: integer("schema_version").notNull().default(1),
  sourceVersion: integer("source_version"), baseUrl: text("base_url"),
  status: text("status").notNull().default("uninitialized"), setupClosed: boolean("setup_closed").notNull().default(false),
  installedAt: epoch("installed_at").notNull().default(0), createdAt: auditTime("created_at").notNull().defaultNow(),
  updatedAt: auditTime("updated_at").notNull().defaultNow(),
  migrationProvenance: jsonb("migration_provenance").$type<JsonObject>().notNull().default({}),
}, (t) => [check("installation_singleton", sql`${t.id} = 1`), check("installation_status", sql`${t.status} in ('uninitialized','ready','maintenance','uninstalled')`), safe("installation_installed_at", t.installedAt), check("installation_schema_version", sql`${t.schemaVersion} > 0`)]);

export const owners = pgTable("owner", {
  id: id(), email: text("email").notNull(), emailKey: varchar("email_key", { length: 320 }).notNull(),
  passwordHash: text("password_hash").notNull(), credentialVersion: integer("credential_version").notNull().default(1),
  authEpoch: epoch("auth_epoch").notNull().default(1), recoveryRequired: boolean("recovery_required").notNull().default(false),
  passwordChangedAt: auditTime("password_changed_at").notNull().defaultNow(),
  createdAt: auditTime("created_at").notNull().defaultNow(), updatedAt: auditTime("updated_at").notNull().defaultNow(),
}, (t) => [check("owner_singleton", sql`${t.id} = 1`), uniqueIndex("owner_email_key_unique").on(t.emailKey), safe("owner_auth_epoch", t.authEpoch, 1), check("owner_credential_version", sql`${t.credentialVersion} > 0`)]);
export const owner = owners;

export const feverCredentials = pgTable("fever_credentials", {
  id: id(), ownerId: ref("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  verifier: digest("verifier").notNull(), source: text("source").notNull().default("local"),
  authEpoch: epoch("auth_epoch").notNull().default(1), createdAt: auditTime("created_at").notNull().defaultNow(),
  revokedAt: auditTime("revoked_at"),
}, (t) => [safe("fever_credentials_id", t.id, 1), safe("fever_credentials_epoch", t.authEpoch, 1), uniqueIndex("fever_credentials_verifier_unique").on(t.verifier), uniqueIndex("fever_credentials_active_owner_unique").on(t.ownerId).where(sql`${t.revokedAt} is null`)]);

export const authRecoveryTokens = pgTable("auth_recovery_tokens", {
  id: id(), ownerId: ref("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  tokenHash: digest("token_hash").notNull(), purpose: text("purpose").notNull().default("password-reset"),
  authEpoch: epoch("auth_epoch").notNull(), createdAt: auditTime("created_at").notNull().defaultNow(),
  expiresAt: auditTime("expires_at").notNull(), usedAt: auditTime("used_at"),
}, (t) => [safe("auth_recovery_tokens_id", t.id, 1), safe("auth_recovery_tokens_epoch", t.authEpoch, 1), uniqueIndex("auth_recovery_tokens_hash_unique").on(t.tokenHash), index("auth_recovery_tokens_expiry_idx").on(t.expiresAt), check("auth_recovery_tokens_expiry", sql`${t.expiresAt} > ${t.createdAt}`)]);

export const authRateLimits = pgTable("auth_rate_limits", {
  subjectHash: digest("subject_hash").notNull(), windowStart: auditTime("window_start").notNull(),
  count: integer("count").notNull().default(0), blockedUntil: auditTime("blocked_until"), expiresAt: auditTime("expires_at").notNull(),
}, (t) => [primaryKey({ columns: [t.subjectHash, t.windowStart], name: "auth_rate_limits_pkey" }), check("auth_rate_limits_count", sql`${t.count} >= 0`), index("auth_rate_limits_expiry_idx").on(t.expiresAt)]);

export const readerPreferences = pgTable("reader_preferences", {
  ownerId: ref("owner_id").primaryKey().references(() => owners.id, { onDelete: "cascade" }), version: integer("version").notNull().default(1),
  useCelsius: boolean("use_celsius").notNull().default(false), refreshInterval: integer("refresh_interval").notNull().default(15),
  itemExpiration: integer("item_expiration").notNull().default(10), newWindow: boolean("new_window").notNull().default(true),
  unreadCounts: boolean("unread_counts").notNull().default(false), layout: smallint("layout").notNull().default(0),
  itemExcerpts: boolean("item_excerpts").notNull().default(true), itemAllows: smallint("item_allows").notNull().default(1),
  sortOrder: smallint("sort_order").notNull().default(0), autoSpark: boolean("auto_spark").notNull().default(false),
  perPage: integer("per_page").notNull().default(20), autoRead: boolean("auto_read").notNull().default(true),
  mobileReadOnScroll: boolean("mobile_read_on_scroll").notNull().default(true), mobileReadOnBackOut: boolean("mobile_read_on_back_out").notNull().default(true),
  mobileViewInApp: boolean("mobile_view_in_app").notNull().default(true), autoReload: boolean("auto_reload").notNull().default(false),
  autoRefresh: boolean("auto_refresh").notNull().default(true), autoUpdate: boolean("auto_update").notNull().default(true),
  toggleClick: boolean("toggle_click").notNull().default(true), anonymize: boolean("anonymize").notNull().default(false),
  sessionTimeout: integer("session_timeout").notNull().default(6), blacklist: text("blacklist").notNull().default(""),
  share: boolean("share").notNull().default(false), shareProtected: boolean("share_protected").notNull().default(false),
  updatedAt: auditTime("updated_at").notNull().defaultNow(),
}, (t) => [check("reader_preferences_version", sql`${t.version} > 0`), check("reader_preferences_refresh_interval", sql`${t.refreshInterval} between 1 and 1440`), check("reader_preferences_expiration", sql`${t.itemExpiration} in (2,4,6,10)`), check("reader_preferences_layout", sql`${t.layout} in (0,1)`), check("reader_preferences_allows", sql`${t.itemAllows} between 0 and 2`), check("reader_preferences_sort", sql`${t.sortOrder} in (0,1)`), check("reader_preferences_page", sql`${t.perPage} between 1 and 200`), check("reader_preferences_session", sql`${t.sessionTimeout} between 1 and 1440`)]);

export const readerViewState = pgTable("reader_view_state", {
  ownerId: ref("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }), deviceId: varchar("device_id", { length: 128 }).notNull().default("default"),
  section: text("section").$type<Section>().notNull().default("hot"), previous: text("previous").$type<Section>().notNull().default("hot"),
  groupId: ref("group_id").notNull().default(0), feedId: ref("feed_id").notNull().default(0), search: text("search").notNull().default(""),
  hasFocus: text("has_focus").notNull().default("groups"), showFeeds: boolean("show_feeds").notNull().default(true), showRead: boolean("show_read").notNull().default(true),
  hotStart: integer("hot_start").notNull().default(0), hotRange: integer("hot_range").notNull().default(7),
  lastViewedAt: epoch("last_viewed_at").notNull().default(0), lastSessionAt: epoch("last_session_at").notNull().default(0),
  version: integer("version").notNull().default(1), updatedAt: auditTime("updated_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.ownerId, t.deviceId], name: "reader_view_state_pkey" }), check("reader_view_state_sections", sql`${t.section} in ('hot','kindling','saved','sparks','search') and ${t.previous} in ('hot','kindling','saved','sparks','search')`), safe("reader_view_state_group", t.groupId), safe("reader_view_state_feed", t.feedId), safe("reader_view_state_viewed", t.lastViewedAt), safe("reader_view_state_session", t.lastSessionAt), check("reader_view_state_window", sql`${t.hotStart} between 0 and 36500 and ${t.hotRange} between 1 and 36500`), check("reader_view_state_version", sql`${t.version} > 0`)]);

export const sharingServices = pgTable("sharing_services", {
  id: id(), ownerId: ref("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }), position: integer("position").notNull(),
  name: text("name").notNull(), url: text("url").notNull(), originalUrl: text("original_url").notNull(), key: varchar("key", { length: 8 }).notNull().default(""),
  enabled: boolean("enabled").notNull().default(true), reason: text("reason"), transport: text("transport").notNull().default("navigate"),
  createdAt: auditTime("created_at").notNull().defaultNow(), updatedAt: auditTime("updated_at").notNull().defaultNow(),
}, (t) => [safe("sharing_services_id", t.id, 1), uniqueIndex("sharing_services_order_unique").on(t.ownerId, t.position), check("sharing_services_position", sql`${t.position} >= 0`), check("sharing_services_transport", sql`${t.transport} in ('navigate','background','disabled')`)]);

export const favicons = pgTable("favicons", {
  id: id(), ownerId: ref("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }), url: text("url").notNull(), urlKey: digest("url_key").notNull(),
  urlChecksum: epoch("url_checksum").notNull().default(0), mimeType: text("mime_type").notNull().default("image/png"), data: bytea("data").notNull(),
  contentHash: digest("content_hash").notNull(), cachedAt: epoch("cached_at").notNull().default(0), isDefault: boolean("is_default").notNull().default(false),
}, (t) => [safe("favicons_id", t.id, 1), crc("favicons_checksum", t.urlChecksum), safe("favicons_cached_at", t.cachedAt), uniqueIndex("favicons_url_key_unique").on(t.ownerId, t.urlKey), uniqueIndex("favicons_default_unique").on(t.ownerId).where(sql`${t.isDefault}`), index("favicons_hash_idx").on(t.contentHash)]);

export const groups = pgTable("groups", {
  id: id(), ownerId: ref("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }), title: text("title").notNull(),
  itemExcerpts: smallint("item_excerpts").notNull().default(-1), itemAllows: smallint("item_allows").notNull().default(-1),
  unreadCounts: smallint("unread_counts").notNull().default(-1), sortOrder: smallint("sort_order").notNull().default(-1),
  createdAt: auditTime("created_at").notNull().defaultNow(), updatedAt: auditTime("updated_at").notNull().defaultNow(),
}, (t) => [safe("groups_id", t.id, 1), check("groups_display_options", sql`${t.itemExcerpts} in (-1,0,1) and ${t.itemAllows} in (-1,0,1,2) and ${t.unreadCounts} in (-1,0,1) and ${t.sortOrder} in (-1,0,1)`)]);

export const feeds = pgTable("feeds", {
  id: id(), ownerId: ref("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  url: text("url").notNull(), originalUrl: text("original_url").notNull(), canonicalUrl: text("canonical_url").notNull(), urlKey: digest("url_key").notNull(),
  urlChecksum: epoch("url_checksum").notNull().default(0), title: text("title").notNull().default(""), customTitle: text("custom_title"), siteUrl: text("site_url").notNull().default(""), domain: text("domain").notNull().default(""),
  faviconId: ref("favicon_id").references(() => favicons.id, { onDelete: "set null" }),
  requiresAuth: boolean("requires_auth").notNull().default(false), isSpark: boolean("is_spark").notNull().default(false), preventsHotlinking: boolean("prevents_hotlinking").notNull().default(false),
  itemExcerpts: smallint("item_excerpts").notNull().default(-1), itemAllows: smallint("item_allows").notNull().default(-1), unreadCounts: smallint("unread_counts").notNull().default(-1), sortOrder: smallint("sort_order").notNull().default(-1),
  createdAt: auditTime("created_at").notNull().defaultNow(), updatedAt: auditTime("updated_at").notNull().defaultNow(),
}, (t) => [safe("feeds_id", t.id, 1), crc("feeds_checksum", t.urlChecksum), uniqueIndex("feeds_url_key_unique").on(t.ownerId, t.urlKey), index("feeds_spark_idx").on(t.ownerId, t.isSpark), index("feeds_favicon_idx").on(t.faviconId), check("feeds_display_options", sql`${t.itemExcerpts} in (-1,0,1) and ${t.itemAllows} in (-1,0,1,2) and ${t.unreadCounts} in (-1,0,1) and ${t.sortOrder} in (-1,0,1)`)]);

export const feedGroups = pgTable("feed_groups", {
  feedId: ref("feed_id").notNull().references(() => feeds.id, { onDelete: "cascade" }), groupId: ref("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.feedId, t.groupId], name: "feed_groups_pkey" }), index("feed_groups_group_idx").on(t.groupId, t.feedId)]);

export const feedCredentials = pgTable("feed_credentials", {
  feedId: ref("feed_id").primaryKey().references(() => feeds.id, { onDelete: "cascade" }), ciphertext: text("ciphertext").notNull(), keyId: varchar("key_id", { length: 64 }).notNull(),
  lastAuthError: text("last_auth_error"), updatedAt: auditTime("updated_at").notNull().defaultNow(),
});

export const feedFetchState = pgTable("feed_fetch_state", {
  feedId: ref("feed_id").primaryKey().references(() => feeds.id, { onDelete: "cascade" }),
  lastRefreshedAt: epoch("last_refreshed_at").notNull().default(0), lastSuccessAt: epoch("last_success_at").notNull().default(0), lastUpdatedAt: epoch("last_updated_at").notNull().default(0), lastAddedAt: epoch("last_added_at").notNull().default(0),
  nextAttemptAt: epoch("next_attempt_at").notNull().default(0), status: text("status").notNull().default("pending"), lastStatusCode: integer("last_status_code"), lastError: text("last_error"),
  etag: text("etag"), lastModified: text("last_modified"), finalUrl: text("final_url"), redirectHistory: jsonb("redirect_history").$type<string[]>().notNull().default([]),
  failureCount: integer("failure_count").notNull().default(0), leaseOwner: text("lease_owner"), leaseExpiresAt: auditTime("lease_expires_at"), fence: epoch("fence").notNull().default(0),
  updatedAt: auditTime("updated_at").notNull().defaultNow(),
}, (t) => [safe("feed_fetch_state_refreshed", t.lastRefreshedAt), safe("feed_fetch_state_success", t.lastSuccessAt), safe("feed_fetch_state_updated", t.lastUpdatedAt), safe("feed_fetch_state_added", t.lastAddedAt), safe("feed_fetch_state_next", t.nextAttemptAt), safe("feed_fetch_state_fence", t.fence), check("feed_fetch_state_failures", sql`${t.failureCount} >= 0`), index("feed_fetch_state_due_idx").on(t.nextAttemptAt), index("feed_fetch_state_lease_idx").on(t.leaseExpiresAt)]);

export const items = pgTable("items", {
  id: id(), feedId: ref("feed_id").notNull().references(() => feeds.id, { onDelete: "cascade" }),
  rawUid: text("raw_uid").notNull().default(""), legacyUid: text("legacy_uid"), identityKey: digest("identity_key").notNull(), identityVersion: integer("identity_version").notNull().default(1),
  title: text("title").notNull().default(""), author: text("author").notNull().default(""), rawHtml: text("raw_html").notNull().default(""),
  html: text("html").notNull().default(""), searchText: text("search_text").notNull().default(""), sanitizerVersion: integer("sanitizer_version").notNull().default(1),
  url: text("url").notNull().default(""), canonicalUrl: text("canonical_url").notNull().default(""), urlKey: digest("url_key"), urlChecksum: epoch("url_checksum").notNull().default(0),
  publishedAt: epoch("published_at").notNull(), addedAt: epoch("added_at").notNull(), readAt: epoch("read_at").notNull().default(0), isSaved: boolean("is_saved").notNull().default(false),
  updatedAt: epoch("updated_at").notNull().default(0), contentHash: digest("content_hash"), sourceFingerprint: digest("source_fingerprint"), stateVersion: epoch("state_version").notNull().default(0),
}, (t) => [safe("items_id", t.id, 1), safe("items_published", t.publishedAt), safe("items_added", t.addedAt), safe("items_read", t.readAt), safe("items_updated", t.updatedAt), safe("items_state_version", t.stateVersion), crc("items_checksum", t.urlChecksum),
  uniqueIndex("items_feed_identity_unique").on(t.feedId, t.identityKey), unique("items_feed_id_id_unique").on(t.feedId, t.id),
  index("items_feed_publication_idx").on(t.feedId, t.publishedAt, t.id), index("items_read_feed_added_idx").on(t.readAt, t.feedId, t.addedAt, t.id),
  index("items_feed_navigation_idx").on(t.feedId, t.readAt, t.isSaved),
  index("items_saved_publication_idx").on(t.publishedAt, t.id).where(sql`${t.isSaved}`), index("items_publication_idx").on(t.publishedAt, t.id), index("items_url_key_idx").on(t.urlKey),
  check("items_versions", sql`${t.identityVersion} > 0 and ${t.sanitizerVersion} > 0`),
]);

export const itemIdentityAliases = pgTable("item_identity_aliases", {
  feedId: ref("feed_id").notNull().references(() => feeds.id, { onDelete: "cascade" }), aliasKey: digest("alias_key").notNull(),
  alias: text("alias").notNull(), kind: text("kind").notNull(), itemId: ref("item_id").notNull(), identityVersion: integer("identity_version").notNull().default(1),
  createdAt: auditTime("created_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.feedId, t.aliasKey], name: "item_identity_aliases_pkey" }), foreignKey({ columns: [t.feedId, t.itemId], foreignColumns: [items.feedId, items.id], name: "item_identity_aliases_item_fk" }).onDelete("cascade"), index("item_identity_aliases_item_idx").on(t.itemId), check("item_identity_aliases_version", sql`${t.identityVersion} > 0`)]);

export const linkOccurrences = pgTable("link_occurrences", {
  id: id(), feedId: ref("feed_id").notNull().references(() => feeds.id, { onDelete: "cascade" }), itemId: ref("item_id").notNull(),
  url: text("url").notNull(), originalUrl: text("original_url").notNull().default(""), canonicalUrl: text("canonical_url").notNull(), urlKey: digest("url_key").notNull(), title: text("title").notNull().default(""),
  urlChecksum: epoch("url_checksum").notNull(), titleUrlChecksum: epoch("title_url_checksum").notNull(), createdAt: epoch("created_at").notNull(),
  isItem: boolean("is_item").notNull().default(false), isLocal: boolean("is_local").notNull().default(false), isFirst: boolean("is_first").notNull().default(false), isBlacklisted: boolean("is_blacklisted").notNull().default(false),
  weight: epoch("weight").notNull().default(0), normalizationVersion: integer("normalization_version").notNull().default(1), rankingVersion: integer("ranking_version").notNull().default(1),
}, (t) => [safe("link_occurrences_id", t.id, 1), safe("link_occurrences_created", t.createdAt), crc("link_occurrences_checksum", t.urlChecksum), crc("link_occurrences_title_checksum", t.titleUrlChecksum), crc("link_occurrences_weight", t.weight), check("link_occurrences_versions", sql`${t.normalizationVersion} > 0 and ${t.rankingVersion} > 0`),
  foreignKey({ columns: [t.feedId, t.itemId], foreignColumns: [items.feedId, items.id], name: "link_occurrences_item_fk" }).onDelete("cascade"),
  index("link_occurrences_item_idx").on(t.itemId), index("link_occurrences_feed_key_time_idx").on(t.feedId, t.urlKey, t.createdAt, t.id),
  index("link_occurrences_key_time_idx").on(t.urlKey, t.createdAt), index("link_occurrences_legacy_checksum_idx").on(t.urlChecksum, t.createdAt),
  index("link_occurrences_hot_idx").on(t.createdAt, t.urlChecksum).where(sql`${t.isFirst} and not ${t.isBlacklisted}`),
]);

export const blacklistRules = pgTable("blacklist_rules", {
  id: id(), ownerId: ref("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }), position: integer("position").notNull(),
  kind: text("kind").notNull(), pattern: text("pattern").notNull(), originalRule: text("original_rule").notNull(), enabled: boolean("enabled").notNull().default(true),
  status: text("status").notNull().default("valid"), error: text("error"), version: integer("version").notNull().default(1), updatedAt: auditTime("updated_at").notNull().defaultNow(),
}, (t) => [safe("blacklist_rules_id", t.id, 1), uniqueIndex("blacklist_rules_order_unique").on(t.ownerId, t.position), check("blacklist_rules_kind", sql`${t.kind} in ('exact','domain','regex')`), check("blacklist_rules_position", sql`${t.position} >= 0`), check("blacklist_rules_version", sql`${t.version} > 0`)]);

export const refreshJobs = pgTable("refresh_jobs", {
  id: id(), ownerId: ref("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }), requester: text("requester").notNull().default("owner"),
  scope: text("scope").$type<"all" | "group" | "feed">().notNull(), scopeId: ref("scope_id"), force: boolean("force").notNull().default(false), faviconOnly: boolean("favicon_only").notNull().default(false),
  deduplicationKey: digest("deduplication_key").notNull(), status: text("status").$type<"queued" | "running" | "completed" | "failed" | "cancelled">().notNull().default("queued"),
  totalFeeds: integer("total_feeds").notNull().default(0), completedFeeds: integer("completed_feeds").notNull().default(0), failedFeeds: integer("failed_feeds").notNull().default(0),
  currentFeedId: ref("current_feed_id").references(() => feeds.id, { onDelete: "set null" }), currentFeedTitle: text("current_feed_title"), error: text("error"),
  createdAt: auditTime("created_at").notNull().defaultNow(), dueAt: auditTime("due_at").notNull().defaultNow(), startedAt: auditTime("started_at"), finishedAt: auditTime("finished_at"), cancelRequestedAt: auditTime("cancel_requested_at"),
  leaseOwner: text("lease_owner"), leaseExpiresAt: auditTime("lease_expires_at"), fence: epoch("fence").notNull().default(0), attempts: integer("attempts").notNull().default(0), maxAttempts: integer("max_attempts").notNull().default(5),
}, (t) => [safe("refresh_jobs_id", t.id, 1), safe("refresh_jobs_scope_id", t.scopeId, 1), safe("refresh_jobs_fence", t.fence), check("refresh_jobs_scope", sql`(${t.scope} = 'all' and ${t.scopeId} is null) or (${t.scope} in ('group','feed') and ${t.scopeId} is not null)`), check("refresh_jobs_status", sql`${t.status} in ('queued','running','completed','failed','cancelled')`), check("refresh_jobs_counts", sql`${t.totalFeeds} >= 0 and ${t.completedFeeds} >= 0 and ${t.completedFeeds} <= ${t.totalFeeds} and ${t.failedFeeds} >= 0 and ${t.failedFeeds} <= ${t.completedFeeds}`), check("refresh_jobs_attempts", sql`${t.attempts} >= 0 and ${t.maxAttempts} > 0`),
  uniqueIndex("refresh_jobs_active_unique").on(t.ownerId, t.deduplicationKey).where(sql`${t.status} in ('queued','running')`), index("refresh_jobs_due_idx").on(t.status, t.dueAt, t.id), index("refresh_jobs_lease_idx").on(t.leaseExpiresAt),
]);

export const jobFeedResults = pgTable("job_feed_results", {
  id: id(), jobId: ref("job_id").notNull().references(() => refreshJobs.id, { onDelete: "cascade" }), feedId: ref("feed_id").notNull().references(() => feeds.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("queued"), attempts: integer("attempts").notNull().default(0), addedItems: integer("added_items").notNull().default(0), updatedItems: integer("updated_items").notNull().default(0),
  statusCode: integer("status_code"), error: text("error"), startedAt: auditTime("started_at"), finishedAt: auditTime("finished_at"), fence: epoch("fence").notNull().default(0),
}, (t) => [safe("job_feed_results_id", t.id, 1), safe("job_feed_results_fence", t.fence), uniqueIndex("job_feed_results_job_feed_unique").on(t.jobId, t.feedId), index("job_feed_results_queue_idx").on(t.jobId, t.status, t.id), check("job_feed_results_counts", sql`${t.attempts} >= 0 and ${t.addedItems} >= 0 and ${t.updatedItems} >= 0`)]);

export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(), ownerId: ref("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  startedAt: auditTime("started_at").notNull().defaultNow(), heartbeatAt: auditTime("heartbeat_at").notNull().defaultNow(),
  activeJobId: ref("active_job_id").references(() => refreshJobs.id, { onDelete: "set null" }),
  version: text("version"), stoppedAt: auditTime("stopped_at"),
}, (t) => [index("worker_heartbeats_owner_time_idx").on(t.ownerId, t.heartbeatAt), index("worker_heartbeats_active_job_idx").on(t.activeJobId)]);

export const stateOperations = pgTable("state_operations", {
  id: id(), ownerId: ref("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }), idempotencyKey: varchar("idempotency_key", { length: 128 }),
  origin: text("origin").notNull(), action: text("action").notNull(), affectedIds: jsonb("affected_ids").$type<number[]>().notNull().default([]),
  before: jsonb("before").$type<JsonObject>().notNull().default({}), after: jsonb("after").$type<JsonObject>().notNull().default({}),
  version: epoch("version").notNull().default(1), createdAt: auditTime("created_at").notNull().defaultNow(), undoneAt: auditTime("undone_at"), expiresAt: auditTime("expires_at"),
}, (t) => [safe("state_operations_id", t.id, 1), safe("state_operations_version", t.version, 1), uniqueIndex("state_operations_idempotency_unique").on(t.ownerId, t.idempotencyKey), index("state_operations_recent_idx").on(t.ownerId, t.createdAt, t.id), index("state_operations_expiry_idx").on(t.expiresAt)]);

/** Source entries that cannot safely merge remain operator-only evidence. */
export const ingestQuarantine = pgTable("ingest_quarantine", {
  id: id(), feedId: ref("feed_id").notNull().references(() => feeds.id, { onDelete: "cascade" }),
  jobId: ref("job_id").references(() => refreshJobs.id, { onDelete: "set null" }),
  identityKey: digest("identity_key").notNull(), code: text("code").notNull(), sourceFingerprint: digest("source_fingerprint").notNull(),
  payload: jsonb("payload").$type<JsonObject>().notNull(), firstSeenAt: auditTime("first_seen_at").notNull().defaultNow(),
  lastSeenAt: auditTime("last_seen_at").notNull().defaultNow(), occurrences: epoch("occurrences").notNull().default(1),
}, (t) => [safe("ingest_quarantine_id", t.id, 1), safe("ingest_quarantine_occurrences", t.occurrences, 1), uniqueIndex("ingest_quarantine_source_unique").on(t.feedId, t.sourceFingerprint, t.code), index("ingest_quarantine_feed_time_idx").on(t.feedId, t.lastSeenAt)]);

export const migrationRuns = pgTable("migration_runs", {
  id: id(), sourceKind: text("source_kind").notNull(), sourceFingerprint: digest("source_fingerprint").notNull(), targetFingerprint: digest("target_fingerprint").notNull(),
  schemaVersion: integer("schema_version").notNull(), policyVersion: integer("policy_version").notNull().default(1), status: text("status").notNull().default("pending"), stage: text("stage").notNull().default("inventory"),
  manifest: jsonb("manifest").$type<JsonObject>().notNull().default({}), checkpoints: jsonb("checkpoints").$type<JsonObject>().notNull().default({}), counts: jsonb("counts").$type<JsonObject>().notNull().default({}), idMaps: jsonb("id_maps").$type<JsonObject>().notNull().default({}),
  createdAt: auditTime("created_at").notNull().defaultNow(), updatedAt: auditTime("updated_at").notNull().defaultNow(), completedAt: auditTime("completed_at"),
}, (t) => [safe("migration_runs_id", t.id, 1), uniqueIndex("migration_runs_source_target_unique").on(t.sourceFingerprint, t.targetFingerprint), check("migration_runs_versions", sql`${t.schemaVersion} > 0 and ${t.policyVersion} > 0`)]);

export const migrationIssues = pgTable("migration_issues", {
  id: id(), runId: ref("run_id").notNull().references(() => migrationRuns.id, { onDelete: "cascade" }), sourceTable: text("source_table").notNull(), sourceId: text("source_id"),
  code: text("code").notNull(), severity: text("severity").notNull().default("error"), message: text("message").notNull(), details: jsonb("details").$type<JsonObject>().notNull().default({}),
  rawData: bytea("raw_data"), rawDataHash: digest("raw_data_hash"), encrypted: boolean("encrypted").notNull().default(false), keyId: varchar("key_id", { length: 64 }),
  disposition: text("disposition").notNull().default("unresolved"), resolution: jsonb("resolution").$type<JsonObject>(), createdAt: auditTime("created_at").notNull().defaultNow(), resolvedAt: auditTime("resolved_at"),
}, (t) => [safe("migration_issues_id", t.id, 1), index("migration_issues_run_status_idx").on(t.runId, t.disposition), index("migration_issues_source_idx").on(t.runId, t.sourceTable)]);

export const maintenanceBackups = pgTable("maintenance_backups", {
  id: id(), ownerId: ref("owner_id").notNull(), operation: text("operation").notNull(), ciphertext: text("ciphertext").notNull(), keyId: varchar("key_id", { length: 64 }).notNull(),
  snapshotHash: digest("snapshot_hash").notNull(), counts: jsonb("counts").$type<Record<string, number>>().notNull().default({}), createdAt: auditTime("created_at").notNull().defaultNow(),
}, (t) => [safe("maintenance_backups_id", t.id, 1), safe("maintenance_backups_owner", t.ownerId, 1), index("maintenance_backups_owner_time_idx").on(t.ownerId, t.createdAt)]);

export const maintenanceChallenges = pgTable("maintenance_challenges", {
  id: id(), ownerId: ref("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }), operation: text("operation").notNull(), tokenHash: digest("token_hash").notNull(), authEpoch: epoch("auth_epoch").notNull(),
  snapshotHash: digest("snapshot_hash").notNull(), counts: jsonb("counts").$type<Record<string, number>>().notNull().default({}), createdAt: auditTime("created_at").notNull().defaultNow(), expiresAt: auditTime("expires_at").notNull(), usedAt: auditTime("used_at"),
}, (t) => [safe("maintenance_challenges_id", t.id, 1), safe("maintenance_challenges_epoch", t.authEpoch, 1), uniqueIndex("maintenance_challenges_token_unique").on(t.tokenHash), index("maintenance_challenges_expiry_idx").on(t.expiresAt), check("maintenance_challenges_expiry", sql`${t.expiresAt} > ${t.createdAt}`)]);

export type OwnerRow = typeof owners.$inferSelect;
export type FeedRow = typeof feeds.$inferSelect;
export type ItemRow = typeof items.$inferSelect;
export type LinkOccurrenceRow = typeof linkOccurrences.$inferSelect;
export type RefreshJobRow = typeof refreshJobs.$inferSelect;

/** Avoid registering the owner compatibility alias twice in Drizzle's schema. */
export const databaseSchema = {
  installation, owners, feverCredentials, authRecoveryTokens, authRateLimits,
  readerPreferences, readerViewState, sharingServices, favicons, groups, feeds,
  feedGroups, feedCredentials, feedFetchState, items, itemIdentityAliases,
  linkOccurrences, blacklistRules, refreshJobs, jobFeedResults, workerHeartbeats, stateOperations,
  ingestQuarantine, migrationRuns, migrationIssues, maintenanceBackups, maintenanceChallenges,
};
