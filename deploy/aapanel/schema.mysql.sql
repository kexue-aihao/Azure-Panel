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

CREATE TABLE IF NOT EXISTS `proxy_profiles` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `name` varchar(120) NOT NULL,
  `type` varchar(16) NOT NULL,
  `host` varchar(255) NOT NULL,
  `port` int NOT NULL,
  `username_encrypted` text,
  `password_encrypted` text,
  `managed_core` varchar(16) DEFAULT '',
  `share_link_encrypted` text,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `proxy_profiles_user_id_idx` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `azure_accounts` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `name` varchar(120) NOT NULL,
  `tenant_id` varchar(64) NOT NULL,
  `client_id` varchar(64) NOT NULL,
  `client_secret_encrypted` text NOT NULL,
  `subscription_id` varchar(64) NOT NULL,
  `proxy_profile_id` int DEFAULT NULL,
  `proxy_url_encrypted` text,
  `remark` varchar(255) DEFAULT '',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `azure_accounts_user_id_idx` (`user_id`),
  KEY `azure_accounts_proxy_profile_id_idx` (`proxy_profile_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `dns_configs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `name` varchar(120) NOT NULL,
  `base_url` varchar(255) NOT NULL,
  `uid` int NOT NULL,
  `api_key_encrypted` text NOT NULL,
  `username_encrypted` text,
  `password_encrypted` text,
  `enabled` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `dns_configs_user_id_idx` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `dns_record_bindings` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `config_id` int NOT NULL,
  `name` varchar(120) NOT NULL,
  `domain_id` int NOT NULL,
  `domain_name` varchar(255) NOT NULL,
  `subdomain` varchar(255) NOT NULL DEFAULT '@',
  `record_type` varchar(16) NOT NULL DEFAULT 'A',
  `line` varchar(120) NOT NULL DEFAULT 'default',
  `ttl` int NOT NULL DEFAULT 60,
  `weight` int DEFAULT NULL,
  `mx` int DEFAULT NULL,
  `remark` varchar(255) DEFAULT '',
  `enabled` tinyint(1) NOT NULL DEFAULT 1,
  `last_a_record_id` varchar(128) DEFAULT '',
  `last_aaaa_record_id` varchar(128) DEFAULT '',
  `last_ipv4` varchar(64) DEFAULT '',
  `last_ipv6` varchar(128) DEFAULT '',
  `last_synced_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `dns_record_bindings_user_id_idx` (`user_id`),
  KEY `dns_record_bindings_config_id_idx` (`config_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `notification_settings` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `telegram_bot_token_encrypted` text NOT NULL,
  `telegram_chat_id` varchar(64) NOT NULL DEFAULT '',
  `telegram_group_chat_ids` text,
  `enabled` tinyint(1) NOT NULL DEFAULT 0,
  `subscription_check_interval_hours` int NOT NULL DEFAULT 6,
  `last_subscription_checked_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `notification_settings_user_id_unique` (`user_id`),
  KEY `notification_settings_enabled_idx` (`enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `subscription_notification_states` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `account_id` int NOT NULL,
  `subscription_id` varchar(64) NOT NULL DEFAULT '',
  `display_name` varchar(255) NOT NULL DEFAULT '',
  `last_state` varchar(64) NOT NULL DEFAULT '',
  `last_notified_state` varchar(64) NOT NULL DEFAULT '',
  `last_checked_at` timestamp NULL DEFAULT NULL,
  `last_notified_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `subscription_notification_states_account_unique` (`user_id`, `account_id`),
  KEY `subscription_notification_states_user_id_idx` (`user_id`),
  KEY `subscription_notification_states_account_id_idx` (`account_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `workflow_policies` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `account_id` int NOT NULL,
  `name` varchar(120) NOT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT 1,
  `resource_group` varchar(90) NOT NULL,
  `location` varchar(64) NOT NULL DEFAULT 'eastus',
  `vm_names_json` text NOT NULL,
  `min_running_count` int NOT NULL DEFAULT 1,
  `replenish_target_count` int NOT NULL DEFAULT 1,
  `auto_start` tinyint(1) NOT NULL DEFAULT 1,
  `auto_create` tinyint(1) NOT NULL DEFAULT 0,
  `vm_size` varchar(64) NOT NULL DEFAULT 'Standard_B1s',
  `image_reference` varchar(255) NOT NULL DEFAULT 'Canonical:ubuntu-24_04-lts:server:latest',
  `name_prefix` varchar(32) NOT NULL DEFAULT 'auto-vm',
  `admin_username` varchar(32) NOT NULL DEFAULT 'azureuser',
  `admin_password_encrypted` text NOT NULL,
  `userdata_encrypted` text,
  `enable_ipv6` tinyint(1) NOT NULL DEFAULT 0,
  `ip_prefix` varchar(32) NOT NULL DEFAULT '',
  `ip_brush_max_attempts` int NOT NULL DEFAULT 30,
  `check_interval_seconds` int NOT NULL DEFAULT 120,
  `status_check_enabled` tinyint(1) NOT NULL DEFAULT 1,
  `status_trigger_states` varchar(120) NOT NULL DEFAULT 'banned,warning,warned',
  `dns_binding_id` int NOT NULL DEFAULT 0,
  `last_account_status` varchar(64) NOT NULL DEFAULT '',
  `last_status_checked_at` timestamp NULL DEFAULT NULL,
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

CREATE TABLE IF NOT EXISTS `execution_logs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `account_id` int NULL,
  `source` varchar(32) NOT NULL DEFAULT 'manual',
  `action` varchar(64) NOT NULL,
  `status` varchar(32) NOT NULL,
  `message` text NOT NULL,
  `resource_group` varchar(90) DEFAULT '',
  `vm_name` varchar(64) DEFAULT '',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `execution_logs_user_id_idx` (`user_id`),
  KEY `execution_logs_account_id_idx` (`account_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
