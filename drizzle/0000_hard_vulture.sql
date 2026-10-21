CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`projectId` text NOT NULL,
	`filename` text NOT NULL,
	`mimeType` text NOT NULL,
	`size` integer NOT NULL,
	`role` text DEFAULT 'source' NOT NULL,
	`objectKey` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'uploaded' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `assets_owner_project` ON `assets` (`userId`,`projectId`);--> statement-breakpoint
CREATE TABLE `audit` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`action` text NOT NULL,
	`entityType` text NOT NULL,
	`entityId` text NOT NULL,
	`details` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_owner` ON `audit` (`userId`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`projectId` text NOT NULL,
	`creativeIds` text DEFAULT '[]' NOT NULL,
	`name` text NOT NULL,
	`channel` text NOT NULL,
	`dailyBudget` real NOT NULL,
	`totalBudget` real NOT NULL,
	`maxDailyBudget` real NOT NULL,
	`targetRoi` real DEFAULT 1 NOT NULL,
	`objective` text NOT NULL,
	`autoOptimize` integer DEFAULT 0 NOT NULL,
	`connectionId` text,
	`platformConfig` text DEFAULT '{}' NOT NULL,
	`remoteState` text DEFAULT '{}' NOT NULL,
	`operationId` text,
	`buyingEmployeeId` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`remoteId` text,
	`error` text,
	`launchStage` text,
	`launchAttemptId` text,
	`lastSyncedAt` text,
	`nextSyncAt` text
);
--> statement-breakpoint
CREATE INDEX `campaigns_owner` ON `campaigns` (`userId`);--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`channel` text NOT NULL,
	`accountId` text NOT NULL,
	`label` text NOT NULL,
	`secretsCiphertext` text NOT NULL,
	`expiresAt` text,
	`appId` text,
	`status` text DEFAULT 'configured' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `connections_owner` ON `connections` (`userId`);--> statement-breakpoint
CREATE TABLE `creatives` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`projectId` text NOT NULL,
	`filename` text NOT NULL,
	`mimeType` text NOT NULL,
	`size` integer NOT NULL,
	`objectKey` text NOT NULL,
	`title` text NOT NULL,
	`variantId` text DEFAULT '' NOT NULL,
	`format` text DEFAULT 'square' NOT NULL,
	`employeeId` text DEFAULT '' NOT NULL,
	`sourceAssetIds` text DEFAULT '[]' NOT NULL,
	`validation` text DEFAULT 'unverified' NOT NULL,
	`width` integer,
	`height` integer,
	`duration` real,
	`status` text DEFAULT 'draft' NOT NULL,
	`reviewedBy` text,
	`reviewedAt` text,
	`metadata` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `creatives_owner_project` ON `creatives` (`userId`,`projectId`);--> statement-breakpoint
CREATE TABLE `employeeProfiles` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`scene` text NOT NULL,
	`definition` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `employees_owner` ON `employeeProfiles` (`userId`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`projectId` text NOT NULL,
	`assetId` text,
	`employeeId` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`details` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_owner` ON `jobs` (`userId`);--> statement-breakpoint
CREATE TABLE `metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`campaignId` text NOT NULL,
	`projectId` text NOT NULL,
	`date` text NOT NULL,
	`source` text NOT NULL,
	`spend` real NOT NULL,
	`revenue` real,
	`conversions` real,
	`hasConversion` integer DEFAULT 0 NOT NULL,
	`dataFresh` integer DEFAULT 0 NOT NULL,
	`impressions` integer,
	`clicks` integer,
	`roi` real,
	`metadata` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metrics_snapshot` ON `metrics` (`userId`,`campaignId`,`date`,`source`);--> statement-breakpoint
CREATE INDEX `metrics_owner` ON `metrics` (`userId`);--> statement-breakpoint
CREATE TABLE `optimizationTasks` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`campaignId` text NOT NULL,
	`projectId` text NOT NULL,
	`type` text DEFAULT 'creative_iteration' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tasks_owner` ON `optimizationTasks` (`userId`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`title` text NOT NULL,
	`productName` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`facts` text DEFAULT '[]' NOT NULL,
	`objective` text DEFAULT 'purchase' NOT NULL,
	`audience` text DEFAULT '' NOT NULL,
	`landingUrl` text DEFAULT '' NOT NULL,
	`scene` text DEFAULT 'general' NOT NULL,
	`productionEmployeeId` text DEFAULT '' NOT NULL,
	`assignment` text DEFAULT '{}' NOT NULL,
	`creativePlan` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `projects_owner` ON `projects` (`userId`);