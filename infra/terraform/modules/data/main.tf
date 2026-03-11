resource "aws_kms_key" "backup" {
  description             = "${var.name_prefix} backup encryption key"
  deletion_window_in_days = 7
  tags                    = var.tags
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.name_prefix}-db-subnets"
  subnet_ids = var.private_subnet_ids
  tags       = var.tags
}

resource "aws_rds_cluster" "this" {
  cluster_identifier              = "${var.name_prefix}-aurora"
  engine                          = "aurora-postgresql"
  engine_version                  = "16.4"
  database_name                   = var.db_name
  master_username                 = var.db_username
  master_password                 = var.db_password
  db_subnet_group_name            = aws_db_subnet_group.this.name
  vpc_security_group_ids          = [var.db_security_group_id]
  backup_retention_period         = 7
  preferred_backup_window         = "17:00-18:00"
  preferred_maintenance_window    = "sun:18:00-sun:19:00"
  storage_encrypted               = true
  kms_key_id                      = aws_kms_key.backup.arn
  copy_tags_to_snapshot           = true
  deletion_protection             = true
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${var.name_prefix}-final-snapshot"
  db_cluster_parameter_group_name = "default.aurora-postgresql16"
  enabled_cloudwatch_logs_exports = ["postgresql"]
  tags                            = var.tags
}

resource "aws_rds_cluster_instance" "writer" {
  identifier          = "${var.name_prefix}-writer-1"
  cluster_identifier  = aws_rds_cluster.this.id
  instance_class      = var.db_instance_class
  engine              = aws_rds_cluster.this.engine
  engine_version      = aws_rds_cluster.this.engine_version
  publicly_accessible = false
  tags                = var.tags
}

resource "aws_rds_cluster_instance" "reader" {
  identifier          = "${var.name_prefix}-reader-1"
  cluster_identifier  = aws_rds_cluster.this.id
  instance_class      = var.db_instance_class
  engine              = aws_rds_cluster.this.engine
  engine_version      = aws_rds_cluster.this.engine_version
  publicly_accessible = false
  promotion_tier      = 15
  tags                = var.tags
}

resource "aws_elasticache_subnet_group" "this" {
  name       = "${var.name_prefix}-cache-subnets"
  subnet_ids = var.private_subnet_ids
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id       = "${var.name_prefix}-redis"
  description                = "${var.name_prefix} redis"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.cache_node_type
  port                       = 6379
  parameter_group_name       = "default.redis7"
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [var.cache_security_group_id]
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  multi_az_enabled           = true
  snapshot_retention_limit   = 7
  tags                       = var.tags
}
