import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Schema changes are deployed as migrations, never created at request time.
const identity = () => ({ id: text('id').primaryKey(), userId: text('userId').notNull(), createdAt: text('createdAt').notNull(), updatedAt: text('updatedAt').notNull() });
export const projects = sqliteTable('projects', {
  productionSpec: text('productionSpec').notNull().default('{}'), sourceState: text('sourceState').notNull().default('{}'),
  ...identity(), title: text('title').notNull(), productName: text('productName').notNull().default(''), description: text('description').notNull().default(''), facts: text('facts').notNull().default('[]'), objective: text('objective').notNull().default('purchase'), audience: text('audience').notNull().default(''), landingUrl: text('landingUrl').notNull().default(''), scene: text('scene').notNull().default('general'), productionEmployeeId: text('productionEmployeeId').notNull().default(''), assignment: text('assignment').notNull().default('{}'), creativePlan: text('creativePlan').notNull().default('{}'),
}, t => [index('projects_owner').on(t.userId)]);
export const assets = sqliteTable('assets', {
  uploadRequestId: text('uploadRequestId'),
  ...identity(), projectId: text('projectId').notNull(), filename: text('filename').notNull(), mimeType: text('mimeType').notNull(), size: integer('size').notNull(), role: text('role').notNull().default('source'), objectKey: text('objectKey').notNull(), metadata: text('metadata').notNull().default('{}'), status: text('status').notNull().default('uploaded'),
}, t => [index('assets_owner_project').on(t.userId,t.projectId), uniqueIndex('assets_upload_request').on(t.userId,t.projectId,t.uploadRequestId)]);
export const creatives = sqliteTable('creatives', {
  ...identity(), projectId: text('projectId').notNull(), filename: text('filename').notNull(), mimeType: text('mimeType').notNull(), size: integer('size').notNull(), objectKey: text('objectKey').notNull(), title: text('title').notNull(), variantId: text('variantId').notNull().default(''), format: text('format').notNull().default('square'), employeeId: text('employeeId').notNull().default(''), sourceAssetIds: text('sourceAssetIds').notNull().default('[]'), validation: text('validation').notNull().default('unverified'), width: integer('width'), height: integer('height'), duration: real('duration'), status: text('status').notNull().default('draft'), reviewedBy: text('reviewedBy'), reviewedAt: text('reviewedAt'), metadata: text('metadata').notNull().default('{}'),
}, t => [index('creatives_owner_project').on(t.userId,t.projectId)]);
export const campaigns = sqliteTable('campaigns', {
  deliveryGroupId: text('deliveryGroupId'), unitKey: text('unitKey'),
  ...identity(), projectId: text('projectId').notNull(), creativeIds: text('creativeIds').notNull().default('[]'), name: text('name').notNull(), channel: text('channel').notNull(), dailyBudget: real('dailyBudget').notNull(), totalBudget: real('totalBudget').notNull(), maxDailyBudget: real('maxDailyBudget').notNull(), targetRoi: real('targetRoi').notNull().default(1), objective: text('objective').notNull(), autoOptimize: integer('autoOptimize').notNull().default(0), connectionId: text('connectionId'), platformConfig: text('platformConfig').notNull().default('{}'), remoteState: text('remoteState').notNull().default('{}'), operationId: text('operationId'), buyingEmployeeId: text('buyingEmployeeId').notNull(), status: text('status').notNull().default('draft'), remoteId: text('remoteId'), error: text('error'), launchStage: text('launchStage'), launchAttemptId: text('launchAttemptId'), lastSyncedAt: text('lastSyncedAt'), nextSyncAt: text('nextSyncAt'),
}, t => [index('campaigns_owner').on(t.userId), index('campaigns_owner_group').on(t.userId,t.deliveryGroupId), uniqueIndex('campaigns_delivery_unit').on(t.userId,t.deliveryGroupId,t.unitKey)]);

export const deliveryGroups = sqliteTable('deliveryGroups', {
  ...identity(), projectId: text('projectId').notNull(), name: text('name').notNull(), dailyBudget: real('dailyBudget').notNull(), totalBudget: real('totalBudget').notNull(), status: text('status').notNull().default('draft'), policy: text('policy').notNull().default('{}'), operationId: text('operationId'),
}, t => [uniqueIndex('delivery_groups_owner_project').on(t.userId,t.projectId)]);

export const userPreferences = sqliteTable('userPreferences', {
  ...identity(), displayName: text('displayName').notNull().default(''), notificationEmail: text('notificationEmail').notNull().default(''), preferences: text('preferences').notNull().default('{}'),
}, t => [uniqueIndex('preferences_owner').on(t.userId)]);

export const decisions = sqliteTable('decisions', {
  ...identity(), projectId: text('projectId'), campaignId: text('campaignId'), type: text('type').notNull(), status: text('status').notNull().default('proposed'), title: text('title').notNull(), reason: text('reason').notNull(), evidence: text('evidence').notNull().default('{}'), actionPlan: text('actionPlan').notNull().default('{}'), result: text('result').notNull().default('{}'),
}, t => [index('decisions_owner').on(t.userId)]);

export const strategies = sqliteTable('strategies', {
  ...identity(), projectId: text('projectId'), campaignId: text('campaignId'), name: text('name').notNull(), version: integer('version').notNull().default(1), status: text('status').notNull().default('hypothesis'), kind: text('kind').notNull(), definition: text('definition').notNull().default('{}'), evidence: text('evidence').notNull().default('{}'), sourceDecisionId: text('sourceDecisionId'),
}, t => [index('strategies_owner').on(t.userId)]);
export const metrics = sqliteTable('metrics', {
  ...identity(), campaignId: text('campaignId').notNull(), projectId: text('projectId').notNull(), date: text('date').notNull(), source: text('source').notNull(), spend: real('spend').notNull(), revenue: real('revenue'), conversions: real('conversions'), hasConversion: integer('hasConversion').notNull().default(0), dataFresh: integer('dataFresh').notNull().default(0), impressions: integer('impressions'), clicks: integer('clicks'), roi: real('roi'), metadata: text('metadata').notNull().default('{}'),
}, t => [uniqueIndex('metrics_snapshot').on(t.userId,t.campaignId,t.date,t.source),index('metrics_owner').on(t.userId)]);
export const connections = sqliteTable('connections', {
  ...identity(), channel: text('channel').notNull(), accountId: text('accountId').notNull(), label: text('label').notNull(), secretsCiphertext: text('secretsCiphertext').notNull(), expiresAt: text('expiresAt'), appId: text('appId'), status: text('status').notNull().default('configured'),
}, t => [index('connections_owner').on(t.userId)]);
export const audit = sqliteTable('audit', {
  ...identity(), action: text('action').notNull(), entityType: text('entityType').notNull(), entityId: text('entityId').notNull(), details: text('details').notNull().default('{}'),
}, t => [index('audit_owner').on(t.userId)]);
export const optimizationTasks = sqliteTable('optimizationTasks', {
  ...identity(), campaignId: text('campaignId').notNull(), projectId: text('projectId').notNull(), type: text('type').notNull().default('creative_iteration'), status: text('status').notNull().default('pending'), reason: text('reason').notNull(), metadata: text('metadata').notNull().default('{}'),
}, t => [index('tasks_owner').on(t.userId)]);
export const jobs = sqliteTable('jobs', {
  ...identity(), projectId: text('projectId').notNull(), assetId: text('assetId'), employeeId: text('employeeId').notNull(), type: text('type').notNull(), status: text('status').notNull(), details: text('details').notNull().default('{}'),
}, t => [index('jobs_owner').on(t.userId)]);

export const employeeProfiles = sqliteTable('employeeProfiles', { ...identity(), name: text('name').notNull(), role: text('role').notNull(), scene: text('scene').notNull(), definition: text('definition').notNull().default('{}') }, t => [index('employees_owner').on(t.userId)]);

// The cookie contains only a random opaque value. Only its digest is persisted.
export const bxagiSessions = sqliteTable('bxagiSessions', {
  ...identity(), subject: text('subject').notNull(), tokenCiphertext: text('tokenCiphertext').notNull(), profile: text('profile').notNull().default('{}'), deviceId: text('deviceId').notNull(), expiresAt: text('expiresAt').notNull(), lastValidatedAt: text('lastValidatedAt').notNull(),
}, t => [index('bxagi_sessions_owner').on(t.userId), index('bxagi_sessions_expiry').on(t.expiresAt)]);

// Application identity comes only from the verified BXAGI subject. Existing
// workspace owners remain opaque IDs when an unambiguous legacy link exists.
export const bxagiAccounts = sqliteTable('bxagiAccounts', {
  subject: text('subject').primaryKey(), userId: text('userId').notNull(), source: text('source').notNull(), createdAt: text('createdAt').notNull(), updatedAt: text('updatedAt').notNull(),
}, t => [uniqueIndex('bxagi_account_owner').on(t.userId)]);
export const bxagiLegacyBindings = sqliteTable('bxagiLegacyBindings', {
  subject: text('subject').notNull(), userId: text('userId').notNull(), createdAt: text('createdAt').notNull(),
}, t => [uniqueIndex('bxagi_legacy_subject_owner').on(t.subject,t.userId)]);

// Catalog imports are durable queues, independent of browser sessions and release batches.
export const catalogSources = sqliteTable('catalogSources', {
  ...identity(), provider: text('provider').notNull().default('changdu'), label: text('label').notNull(),
  distributorId: text('distributorId').notNull(), secretsCiphertext: text('secretsCiphertext').notNull(),
  autoSync: integer('autoSync').notNull().default(0), connectionStatus: text('connectionStatus').notNull().default('pending'),
  lastSuccessAt: text('lastSuccessAt'), lastError: text('lastError'), runStatus: text('runStatus'), cursor: text('cursor'),
  cursorHistory: text('cursorHistory').notNull().default('[]'),
  processed: integer('processed').notNull().default(0), inserted: integer('inserted').notNull().default(0),
  updated: integer('updated').notNull().default(0), pages: integer('pages').notNull().default(0),
  retryCount: integer('retryCount').notNull().default(0), version: integer('version').notNull().default(1),
  leaseToken: text('leaseToken'), leaseUntil: text('leaseUntil'), nextRequestAt: text('nextRequestAt'),
  startedAt: text('startedAt'), finishedAt: text('finishedAt'),
}, t => [uniqueIndex('catalog_source_owner_provider').on(t.userId,t.provider), index('catalog_sources_due').on(t.runStatus,t.nextRequestAt)]);

export const catalogItems = sqliteTable('catalogItems', {
  ...identity(), sourceId: text('sourceId').notNull(), externalId: text('externalId').notNull(),
  businessMode: text('businessMode').notNull().default('unknown'), title: text('title').notNull(),
  episodeCount: integer('episodeCount'), releaseStatus: text('releaseStatus').notNull().default('unknown'),
  publishedAt: text('publishedAt'), sourceUpdatedAt: text('sourceUpdatedAt'), sourceUrl: text('sourceUrl'),
  lastSeenAt: text('lastSeenAt').notNull(), metadataHash: text('metadataHash').notNull(),
}, t => [uniqueIndex('catalog_item_identity').on(t.userId,t.sourceId,t.businessMode,t.externalId),
  index('catalog_item_list').on(t.userId,t.sourceId,t.createdAt,t.id), index('catalog_item_title').on(t.userId,t.sourceId,t.title)]);

// Shared across tenants: one request per second for this upstream interface.
export const catalogThrottle = sqliteTable('catalogThrottle', {
  key: text('key').primaryKey(), nextRequestAt: text('nextRequestAt').notNull(),
});
