variable "name_prefix" { type = string }
variable "vpc_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "private_subnet_ids" { type = list(string) }
variable "alb_security_group_id" { type = string }
variable "app_security_group_id" { type = string }
variable "api_container_port" { type = number }
variable "api_cpu" { type = number }
variable "api_memory" { type = number }
variable "worker_cpu" { type = number }
variable "worker_memory" { type = number }
variable "api_desired_count" { type = number }
variable "worker_desired_count" { type = number }
variable "api_image" { type = string }
variable "worker_image" { type = string }
variable "execution_role_arn" { type = string, default = null }
variable "db_writer_endpoint" { type = string }
variable "db_reader_endpoint" { type = string }
variable "db_name" { type = string }
variable "db_username" { type = string }
variable "db_password" { type = string, sensitive = true }
variable "redis_endpoint" { type = string }
variable "audit_queue_url" { type = string }
variable "audit_dlq_url" { type = string }
variable "opensearch_endpoint" { type = string }
variable "sentry_dsn" { type = string, default = null }
variable "organization_id" { type = string }
variable "access_token_ttl_seconds" { type = number }
variable "refresh_token_ttl_seconds" { type = number }
variable "request_id_header" { type = string }
variable "jwt_access_public_key" { type = string, sensitive = true }
variable "jwt_access_private_key" { type = string, sensitive = true }
variable "jwt_refresh_public_key" { type = string, sensitive = true }
variable "jwt_refresh_private_key" { type = string, sensitive = true }
variable "auth_login_max_attempts" { type = number }
variable "auth_login_lockout_seconds" { type = number }
variable "security_sensitive_window_seconds" { type = number }
variable "tags" { type = map(string) }
