ALTER TABLE `assets` ADD `uploadRequestId` text;--> statement-breakpoint
CREATE UNIQUE INDEX `assets_upload_request` ON `assets` (`userId`,`projectId`,`uploadRequestId`);