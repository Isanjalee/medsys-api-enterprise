variable "region" {
  description = "AWS region where the prod backend lives."
  type        = string
  default     = "ap-southeast-1"
}

variable "project" {
  description = "Name prefix for created CI/CD resources."
  type        = string
  default     = "medlink-backend"
}

variable "github_owner" {
  description = "GitHub org/user that owns the backend repo."
  type        = string
  default     = "Dulanpasindu99"
}

variable "github_repo" {
  description = "Backend repository name."
  type        = string
  default     = "medsys-api-enterprise"
}

variable "github_branch" {
  description = "Branch that triggers a production deploy."
  type        = string
  default     = "main"
}

variable "ec2_instance_id" {
  description = "Instance ID of the prod backend box (SSM deploy target)."
  type        = string
  default     = "i-0e406298a48834557"
}

variable "artifact_bucket_name" {
  description = "S3 bucket for pipeline artifacts. Must be globally unique."
  type        = string
  default     = "medlink-backend-cicd-artifacts-416558141999"
}

variable "codebuild_image" {
  description = "CodeBuild image (must provide Node 22)."
  type        = string
  default     = "aws/codebuild/amazonlinux-x86_64-standard:5.0"
}
