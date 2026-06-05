-- Azure Panel MySQL 8.0 建表脚本
-- 在 aaPanel phpMyAdmin 中导入此文件，或执行: mysql -u root -p azure_panel < schema.mysql.sql

CREATE DATABASE IF NOT EXISTS `azure_panel` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `azure_panel`;

CREATE TABLE IF NOT EXISTS `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `email` varchar(255) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `users_email_unique` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `azure_accounts` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `name` varchar(120) NOT NULL,
  `tenant_id` varchar(64) NOT NULL,
  `client_id` varchar(64) NOT NULL,
  `client_secret_encrypted` text NOT NULL,
  `subscription_id` varchar(64) NOT NULL,
  `remark` varchar(255) DEFAULT '',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `azure_accounts_user_id_idx` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `workflow_policies` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `account_id` int NOT NULL,
  `name` varchar(120) NOT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT 1,
  `resource_group` varchar(90) NOT NULL,
  `location` varchar(64) NOT NULL DEFAULT 'eastus',
  `vm_names_json` text NOT NULL DEFAULT '[]',
  `min_running_count` int NOT NULL DEFAULT 1,
  `auto_start` tinyint(1) NOT NULL DEFAULT 1,
  `auto_create` tinyint(1) NOT NULL DEFAULT 0,
  `vm_size` varchar(64) NOT NULL DEFAULT 'Standard_B1s',
  `image_reference` varchar(255) NOT NULL DEFAULT 'Canonical:ubuntu-24_04-lts:server:latest',
  `name_prefix` varchar(32) NOT NULL DEFAULT 'auto-vm',
  `admin_username` varchar(32) NOT NULL DEFAULT 'azureuser',
  `admin_password_encrypted` text NOT NULL DEFAULT '',
  `check_interval_seconds` int NOT NULL DEFAULT 120,
  `last_run_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `workflow_policies_user_id_idx` (`user_id`),
  KEY `workflow_policies_account_id_idx` (`account_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `workflow_logs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `policy_id` int NOT NULL,
  `action` varchar(64) NOT NULL,
  `status` varchar(32) NOT NULL,
  `message` text NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `workflow_logs_policy_id_idx` (`policy_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
