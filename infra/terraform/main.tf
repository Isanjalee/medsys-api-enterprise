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
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/${local.name_prefix}/api"
  retention_in_days = 30
  tags              = var.tags
}
