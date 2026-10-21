CREATE TABLE `bxagiSessions` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`subject` text NOT NULL,
	`tokenCiphertext` text NOT NULL,
	`profile` text DEFAULT '{}' NOT NULL,
	`deviceId` text NOT NULL,
	`expiresAt` text NOT NULL,
	`lastValidatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bxagi_sessions_owner` ON `bxagiSessions` (`userId`);--> statement-breakpoint
CREATE INDEX `bxagi_sessions_expiry` ON `bxagiSessions` (`expiresAt`);