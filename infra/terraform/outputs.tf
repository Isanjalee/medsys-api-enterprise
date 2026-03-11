output "vpc_id" {
  value = module.network.vpc_id
}

output "alb_dns_name" {
  value = module.app.alb_dns_name
}

output "api_service_name" {
  value = module.app.api_service_name
}

output "worker_service_name" {
  value = module.app.worker_service_name
}

output "cluster_name" {
  value = module.app.cluster_name
}

output "db_writer_endpoint" {
  value = module.data.db_writer_endpoint
}

output "db_reader_endpoint" {
  value = module.data.db_reader_endpoint
}

output "redis_endpoint" {
  value = module.data.redis_endpoint
}

output "audit_queue_url" {
  value = module.messaging.audit_queue_url
}

output "opensearch_endpoint" {
  value = module.search.endpoint
}

output "api_ecr_repository_url" {
  value = module.app.api_ecr_repository_url
}

output "worker_ecr_repository_url" {
  value = module.app.worker_ecr_repository_url
}

output "codedeploy_app_name" {
  value = module.app.codedeploy_app_name
}

output "codedeploy_deployment_group_name" {
  value = module.app.codedeploy_deployment_group_name
}

output "api_task_family" {
  value = module.app.api_task_family
}
