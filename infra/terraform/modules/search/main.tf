resource "aws_cloudwatch_log_group" "index_slow" {
  name              = "/aws/opensearch/${var.name_prefix}/index-slow"
  retention_in_days = 30
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "search_slow" {
  name              = "/aws/opensearch/${var.name_prefix}/search-slow"
  retention_in_days = 30
  tags              = var.tags
}

resource "aws_opensearch_domain" "this" {
  domain_name    = "${var.name_prefix}-search"
  engine_version = "OpenSearch_2.17"

  cluster_config {
    instance_type          = var.instance_type
    instance_count         = var.instance_count
    zone_awareness_enabled = true

    zone_awareness_config {
      availability_zone_count = min(3, length(var.private_subnet_ids))
    }
  }

  ebs_options {
    ebs_enabled = true
    volume_size = var.ebs_volume_size
    volume_type = "gp3"
  }

  encrypt_at_rest {
    enabled = true
  }

  node_to_node_encryption {
    enabled = true
  }

  domain_endpoint_options {
    enforce_https       = true
    tls_security_policy = "Policy-Min-TLS-1-2-2019-07"
  }

  vpc_options {
    subnet_ids         = slice(var.private_subnet_ids, 0, min(2, length(var.private_subnet_ids)))
    security_group_ids = [var.search_security_group_id]
  }

  log_publishing_options {
    cloudwatch_log_group_arn = aws_cloudwatch_log_group.index_slow.arn
    log_type                 = "INDEX_SLOW_LOGS"
  }

  log_publishing_options {
    cloudwatch_log_group_arn = aws_cloudwatch_log_group.search_slow.arn
    log_type                 = "SEARCH_SLOW_LOGS"
  }

  tags = var.tags
}
