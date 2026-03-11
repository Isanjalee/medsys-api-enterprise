output "audit_queue_url" {
  value = aws_sqs_queue.audit.url
}

output "audit_queue_arn" {
  value = aws_sqs_queue.audit.arn
}

output "audit_dlq_url" {
  value = aws_sqs_queue.audit_dlq.url
}
