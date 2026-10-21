CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`projectId` text,
	`campaignId` text,
	`type` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`title` text NOT NULL,
	`reason` text NOT NULL,
	`evidence` text DEFAULT '{}' NOT NULL,
	`actionPlan` text DEFAULT '{}' NOT NULL,
	`result` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `decisions_owner` ON `decisions` (`userId`);--> statement-breakpoint
CREATE TABLE `deliveryGroups` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`projectId` text NOT NULL,
	`name` text NOT NULL,
	`dailyBudget` real NOT NULL,
	`totalBudget` real NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`policy` text DEFAULT '{}' NOT NULL,
	`operationId` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_groups_owner_project` ON `deliveryGroups` (`userId`,`projectId`);--> statement-breakpoint
CREATE TABLE `strategies` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`projectId` text,
	`campaignId` text,
	`name` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'hypothesis' NOT NULL,
	`kind` text NOT NULL,
	`definition` text DEFAULT '{}' NOT NULL,
	`evidence` text DEFAULT '{}' NOT NULL,
	`sourceDecisionId` text
);
--> statement-breakpoint
CREATE INDEX `strategies_owner` ON `strategies` (`userId`);--> statement-breakpoint
CREATE TABLE `userPreferences` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`displayName` text DEFAULT '' NOT NULL,
	`notificationEmail` text DEFAULT '' NOT NULL,
	`preferences` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `preferences_owner` ON `userPreferences` (`userId`);--> statement-breakpoint
ALTER TABLE `campaigns` ADD `deliveryGroupId` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `unitKey` text;--> statement-breakpoint
CREATE INDEX `campaigns_owner_group` ON `campaigns` (`userId`,`deliveryGroupId`);--> statement-breakpoint
CREATE UNIQUE INDEX `campaigns_delivery_unit` ON `campaigns` (`userId`,`deliveryGroupId`,`unitKey`);--> statement-breakpoint
ALTER TABLE `projects` ADD `productionSpec` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `sourceState` text DEFAULT '{}' NOT NULL;