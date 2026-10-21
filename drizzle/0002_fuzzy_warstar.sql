CREATE TABLE `bxagiAccounts` (
	`subject` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`source` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bxagi_account_owner` ON `bxagiAccounts` (`userId`);--> statement-breakpoint
CREATE TABLE `bxagiLegacyBindings` (
	`subject` text NOT NULL,
	`userId` text NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bxagi_legacy_subject_owner` ON `bxagiLegacyBindings` (`subject`,`userId`);
--> statement-breakpoint
INSERT OR IGNORE INTO `bxagiLegacyBindings` (`subject`, `userId`, `createdAt`) SELECT `subject`, `userId`, MIN(`createdAt`) FROM `bxagiSessions` GROUP BY `subject`, `userId`;
