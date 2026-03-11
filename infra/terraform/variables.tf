variable "project" {
  type    = string
  default = "medsys"
}

variable "environment" {
  type = string
}

variable "aws_region" {
  type    = string
  default = "ap-south-1"
}

variable "availability_zones" {
  type = list(string)
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "public_subnet_cidrs" {
  type = list(string)
}

variable "private_subnet_cidrs" {
  type = list(string)
}

variable "db_name" {
  type    = string
  default = "medsys"
}

variable "db_username" {
  type = string
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "db_instance_class" {
  type    = string
  default = "db.r6g.large"
}

variable "cache_node_type" {
  type    = string
  default = "cache.t4g.small"
}

variable "opensearch_instance_type" {
  type    = string
  default = "t3.small.search"
}

variable "opensearch_instance_count" {
  type    = number
  default = 2
}

variable "opensearch_ebs_volume_size" {
  type    = number
  default = 20
}

variable "api_container_port" {
  type    = number
  default = 4000
}

variable "api_cpu" {
  type    = number
  default = 512
}

variable "api_memory" {
  type    = number
  default = 1024
}

variable "worker_cpu" {
  type    = number
  default = 256
}

variable "worker_memory" {
  type    = number
  default = 512
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "worker_desired_count" {
  type    = number
  default = 1
}

variable "api_image" {
  type = string
}

variable "worker_image" {
  type = string
}

variable "execution_role_arn" {
  type        = string
  default     = null
  description = "Optional pre-existing ECS task execution role ARN. Leave null to let Terraform create one."
}

variable "organization_id" {
  type    = string
  default = "11111111-1111-1111-1111-111111111111"
}

variable "access_token_ttl_seconds" {
  type    = number
  default = 900
}

variable "refresh_token_ttl_seconds" {
  type    = number
  default = 604800
}

variable "request_id_header" {
  type    = string
  default = "x-request-id"
}

variable "jwt_access_public_key" {
  type      = string
  sensitive = true
}

variable "jwt_access_private_key" {
  type      = string
  sensitive = true
}

variable "jwt_refresh_public_key" {
  type      = string
  sensitive = true
}

variable "jwt_refresh_private_key" {
  type      = string
  sensitive = true
}

variable "sentry_dsn" {
  type      = string
  default   = null
  sensitive = true
}

variable "auth_login_max_attempts" {
  type    = number
  default = 5
}

variable "auth_login_lockout_seconds" {
  type    = number
  default = 300
}

variable "security_sensitive_window_seconds" {
  type    = number
  default = 3600
}

variable "tags" {
  type    = map(string)
  default = {}
}
