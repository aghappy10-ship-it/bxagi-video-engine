CREATE TABLE `catalogItems` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`sourceId` text NOT NULL,
	`externalId` text NOT NULL,
	`businessMode` text DEFAULT 'unknown' NOT NULL,
	`title` text NOT NULL,
	`episodeCount` integer,
	`releaseStatus` text DEFAULT 'unknown' NOT NULL,
	`publishedAt` text,
	`sourceUpdatedAt` text,
	`sourceUrl` text,
	`lastSeenAt` text NOT NULL,
	`metadataHash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_item_identity` ON `catalogItems` (`userId`,`sourceId`,`businessMode`,`externalId`);--> statement-breakpoint
CREATE INDEX `catalog_item_list` ON `catalogItems` (`userId`,`sourceId`,`createdAt`,`id`);--> statement-breakpoint
CREATE INDEX `catalog_item_title` ON `catalogItems` (`userId`,`sourceId`,`title`);--> statement-breakpoint
CREATE TABLE `catalogSources` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`provider` text DEFAULT 'changdu' NOT NULL,
	`label` text NOT NULL,
	`distributorId` text NOT NULL,
	`secretsCiphertext` text NOT NULL,
	`autoSync` integer DEFAULT 0 NOT NULL,
	`connectionStatus` text DEFAULT 'pending' NOT NULL,
	`lastSuccessAt` text,
	`lastError` text,
	`runStatus` text,
	`cursor` text,
	`processed` integer DEFAULT 0 NOT NULL,
	`inserted` integer DEFAULT 0 NOT NULL,
	`updated` integer DEFAULT 0 NOT NULL,
	`pages` integer DEFAULT 0 NOT NULL,
	`retryCount` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`leaseToken` text,
	`leaseUntil` text,
	`nextRequestAt` text,
	`startedAt` text,
	`finishedAt` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_source_owner_provider` ON `catalogSources` (`userId`,`provider`);--> statement-breakpoint
CREATE INDEX `catalog_sources_due` ON `catalogSources` (`runStatus`,`nextRequestAt`);--> statement-breakpoint
CREATE TABLE `catalogThrottle` (
	`key` text PRIMARY KEY NOT NULL,
	`nextRequestAt` text NOT NULL
);
