output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "api_service_name" {
  value = aws_ecs_service.api.name
}

output "worker_service_name" {
  value = aws_ecs_service.worker.name
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "api_ecr_repository_url" {
  value = aws_ecr_repository.api.repository_url
}

output "worker_ecr_repository_url" {
  value = aws_ecr_repository.worker.repository_url
}

output "codedeploy_app_name" {
  value = aws_codedeploy_app.ecs.name
}

output "codedeploy_deployment_group_name" {
  value = aws_codedeploy_deployment_group.api.deployment_group_name
}

output "api_task_family" {
  value = aws_ecs_task_definition.api.family
}
