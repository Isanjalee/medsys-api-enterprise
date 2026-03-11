output "db_writer_endpoint" {
  value = aws_rds_cluster.this.endpoint
}

output "db_reader_endpoint" {
  value = aws_rds_cluster.this.reader_endpoint
}

output "redis_endpoint" {
  value = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "backup_kms_key_arn" {
  value = aws_kms_key.backup.arn
}
