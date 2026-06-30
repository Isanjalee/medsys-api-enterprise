output "github_connection_arn" {
  description = "Authorize this connection once in the console (Developer Tools > Connections) to move it from PENDING to AVAILABLE."
  value       = aws_codestarconnections_connection.github.arn
}

output "github_connection_status" {
  description = "Should read AVAILABLE after you complete the GitHub authorization."
  value       = aws_codestarconnections_connection.github.connection_status
}

output "pipeline_name" {
  value = aws_codepipeline.api.name
}

output "artifact_bucket" {
  value = aws_s3_bucket.artifacts.bucket
}

output "deploy_target_instance" {
  value = var.ec2_instance_id
}
