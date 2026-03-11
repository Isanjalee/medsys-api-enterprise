terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.90"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

locals {
  name_prefix = "${var.project}-${var.environment}"
  tags = merge(
    {
      project     = var.project
      environment = var.environment
      managed_by  = "terraform"
    },
    var.tags
  )
}

module "network" {
  source = "./modules/network"

  name_prefix          = local.name_prefix
  vpc_cidr             = var.vpc_cidr
  availability_zones   = var.availability_zones
  public_subnet_cidrs  = var.public_subnet_cidrs
  private_subnet_cidrs = var.private_subnet_cidrs
  api_port             = var.api_container_port
  tags                 = local.tags
}

module "data" {
  source = "./modules/data"

  name_prefix             = local.name_prefix
  private_subnet_ids      = module.network.private_subnet_ids
  db_security_group_id    = module.network.data_security_group_id
  cache_security_group_id = module.network.data_security_group_id
  db_name                 = var.db_name
  db_username             = var.db_username
  db_password             = var.db_password
  db_instance_class       = var.db_instance_class
  cache_node_type         = var.cache_node_type
  tags                    = local.tags
}

module "messaging" {
  source = "./modules/messaging"

  name_prefix = local.name_prefix
  tags        = local.tags
}

module "search" {
  source = "./modules/search"

  name_prefix              = local.name_prefix
  private_subnet_ids       = module.network.private_subnet_ids
  search_security_group_id = module.network.search_security_group_id
  instance_type            = var.opensearch_instance_type
  instance_count           = var.opensearch_instance_count
  ebs_volume_size          = var.opensearch_ebs_volume_size
  tags                     = local.tags
}

module "app" {
  source = "./modules/app"

  name_prefix                       = local.name_prefix
  vpc_id                            = module.network.vpc_id
  public_subnet_ids                 = module.network.public_subnet_ids
  private_subnet_ids                = module.network.private_subnet_ids
  alb_security_group_id             = module.network.alb_security_group_id
  app_security_group_id             = module.network.app_security_group_id
  api_container_port                = var.api_container_port
  api_cpu                           = var.api_cpu
  api_memory                        = var.api_memory
  worker_cpu                        = var.worker_cpu
  worker_memory                     = var.worker_memory
  api_desired_count                 = var.api_desired_count
  worker_desired_count              = var.worker_desired_count
  api_image                         = var.api_image
  worker_image                      = var.worker_image
  execution_role_arn                = var.execution_role_arn
  db_writer_endpoint                = module.data.db_writer_endpoint
  db_reader_endpoint                = module.data.db_reader_endpoint
  db_name                           = var.db_name
  db_username                       = var.db_username
  db_password                       = var.db_password
  redis_endpoint                    = module.data.redis_endpoint
  audit_queue_url                   = module.messaging.audit_queue_url
  audit_dlq_url                     = module.messaging.audit_dlq_url
  opensearch_endpoint               = module.search.endpoint
  sentry_dsn                        = var.sentry_dsn
  organization_id                   = var.organization_id
  access_token_ttl_seconds          = var.access_token_ttl_seconds
  refresh_token_ttl_seconds         = var.refresh_token_ttl_seconds
  request_id_header                 = var.request_id_header
  jwt_access_public_key             = var.jwt_access_public_key
  jwt_access_private_key            = var.jwt_access_private_key
  jwt_refresh_public_key            = var.jwt_refresh_public_key
  jwt_refresh_private_key           = var.jwt_refresh_private_key
  auth_login_max_attempts           = var.auth_login_max_attempts
  auth_login_lockout_seconds        = var.auth_login_lockout_seconds
  security_sensitive_window_seconds = var.security_sensitive_window_seconds
  tags                              = local.tags
}
