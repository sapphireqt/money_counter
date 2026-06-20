CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`bank_name` text DEFAULT '' NOT NULL,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`type` text DEFAULT 'checking' NOT NULL,
	`opening_balance_cents` integer DEFAULT 0 NOT NULL,
	`color` text DEFAULT '#2563eb' NOT NULL,
	`archived_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `accounts_name_idx` ON `accounts` (`name`);--> statement-breakpoint
CREATE INDEX `accounts_archived_at_idx` ON `accounts` (`archived_at`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`date` text NOT NULL,
	`description` text NOT NULL,
	`category` text DEFAULT '' NOT NULL,
	`payee` text DEFAULT '' NOT NULL,
	`amount_cents` integer NOT NULL,
	`status` text DEFAULT 'cleared' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `transactions_account_id_idx` ON `transactions` (`account_id`);--> statement-breakpoint
CREATE INDEX `transactions_date_idx` ON `transactions` (`date`);--> statement-breakpoint
CREATE INDEX `transactions_amount_cents_idx` ON `transactions` (`amount_cents`);