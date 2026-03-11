resource "aws_sqs_queue" "audit_dlq" {
  name                       = "${var.name_prefix}-audit-dlq"
  message_retention_seconds  = 1209600
  visibility_timeout_seconds = 30
  tags                       = var.tags
}

resource "aws_sqs_queue" "audit" {
  name                       = "${var.name_prefix}-audit"
  message_retention_seconds  = 345600
  visibility_timeout_seconds = 30
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.audit_dlq.arn
    maxReceiveCount     = 5
  })
  tags = var.tags
}
