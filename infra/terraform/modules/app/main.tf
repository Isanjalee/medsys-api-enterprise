data "aws_region" "current" {}

resource "aws_ecr_repository" "api" {
  name                 = "${var.name_prefix}-api"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = var.tags
}

resource "aws_ecr_repository" "worker" {
  name                 = "${var.name_prefix}-worker"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = var.tags
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/${var.name_prefix}/api"
  retention_in_days = 30
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/${var.name_prefix}/worker"
  retention_in_days = 30
  tags              = var.tags
}

resource "aws_ecs_cluster" "this" {
  name = "${var.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = var.tags
}

resource "aws_iam_role" "execution" {
  count = var.execution_role_arn == null ? 1 : 0

  name = "${var.name_prefix}-ecs-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  count      = var.execution_role_arn == null ? 1 : 0
  role       = aws_iam_role.execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

locals {
  execution_role_arn = var.execution_role_arn != null ? var.execution_role_arn : aws_iam_role.execution[0].arn
  api_environment = concat(
    [
      { name = "NODE_ENV", value = "production" },
      { name = "HOST", value = "0.0.0.0" },
      { name = "PORT", value = tostring(var.api_container_port) },
      { name = "DATABASE_URL", value = "postgres://${var.db_username}:${var.db_password}@${var.db_writer_endpoint}:5432/${var.db_name}" },
      { name = "DATABASE_READ_URL", value = "postgres://${var.db_username}:${var.db_password}@${var.db_reader_endpoint}:5432/${var.db_name}" },
      { name = "REDIS_URL", value = "redis://${var.redis_endpoint}:6379" },
      { name = "OPENSEARCH_URL", value = "https://${var.opensearch_endpoint}" },
      { name = "AUDIT_TRANSPORT", value = "auto" },
      { name = "AUDIT_QUEUE_KEY", value = var.audit_queue_url },
      { name = "AUDIT_DLQ_KEY", value = var.audit_dlq_url },
      { name = "ORGANIZATION_ID", value = var.organization_id },
      { name = "ACCESS_TOKEN_TTL_SECONDS", value = tostring(var.access_token_ttl_seconds) },
      { name = "REFRESH_TOKEN_TTL_SECONDS", value = tostring(var.refresh_token_ttl_seconds) },
      { name = "REQUEST_ID_HEADER", value = var.request_id_header },
      { name = "JWT_ACCESS_PUBLIC_KEY", value = var.jwt_access_public_key },
      { name = "JWT_ACCESS_PRIVATE_KEY", value = var.jwt_access_private_key },
      { name = "JWT_REFRESH_PUBLIC_KEY", value = var.jwt_refresh_public_key },
      { name = "JWT_REFRESH_PRIVATE_KEY", value = var.jwt_refresh_private_key },
      { name = "AUTH_LOGIN_MAX_ATTEMPTS", value = tostring(var.auth_login_max_attempts) },
      { name = "AUTH_LOGIN_LOCKOUT_SECONDS", value = tostring(var.auth_login_lockout_seconds) },
      { name = "SECURITY_SENSITIVE_WINDOW_SECONDS", value = tostring(var.security_sensitive_window_seconds) }
    ],
    var.sentry_dsn == null ? [] : [{ name = "SENTRY_DSN", value = var.sentry_dsn }]
  )
  worker_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "DATABASE_URL", value = "postgres://${var.db_username}:${var.db_password}@${var.db_writer_endpoint}:5432/${var.db_name}" },
    { name = "REDIS_URL", value = "redis://${var.redis_endpoint}:6379" },
    { name = "AUDIT_TRANSPORT", value = "auto" },
    { name = "AUDIT_QUEUE_KEY", value = var.audit_queue_url },
    { name = "AUDIT_DLQ_KEY", value = var.audit_dlq_url }
  ]
}

resource "aws_lb" "this" {
  name               = "${var.name_prefix}-alb"
  load_balancer_type = "application"
  subnets            = var.public_subnet_ids
  security_groups    = [var.alb_security_group_id]
  tags               = var.tags
}

resource "aws_lb_target_group" "blue" {
  name        = "${substr(var.name_prefix, 0, 16)}-blue"
  port        = var.api_container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = var.tags
}

resource "aws_lb_target_group" "green" {
  name        = "${substr(var.name_prefix, 0, 16)}-green"
  port        = var.api_container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = var.tags
}

resource "aws_lb_listener" "prod" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.blue.arn
  }
}

resource "aws_lb_listener" "test" {
  load_balancer_arn = aws_lb.this.arn
  port              = 9000
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.green.arn
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name_prefix}-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.api_cpu)
  memory                   = tostring(var.api_memory)
  execution_role_arn       = local.execution_role_arn
  task_role_arn            = local.execution_role_arn

  container_definitions = jsonencode([
    {
      name         = "api"
      image        = var.api_image
      essential    = true
      portMappings = [{ containerPort = var.api_container_port, hostPort = var.api_container_port, protocol = "tcp" }]
      environment  = local.api_environment
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.api.name
          awslogs-region        = data.aws_region.current.name
          awslogs-stream-prefix = "ecs"
        }
      }
    }
  ])

  tags = var.tags
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name_prefix}-worker"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.worker_cpu)
  memory                   = tostring(var.worker_memory)
  execution_role_arn       = local.execution_role_arn
  task_role_arn            = local.execution_role_arn

  container_definitions = jsonencode([
    {
      name        = "worker"
      image       = var.worker_image
      essential   = true
      environment = local.worker_environment
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.worker.name
          awslogs-region        = data.aws_region.current.name
          awslogs-stream-prefix = "ecs"
        }
      }
    }
  ])

  tags = var.tags
}

resource "aws_ecs_service" "api" {
  name            = "${var.name_prefix}-api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"

  deployment_controller {
    type = "CODE_DEPLOY"
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.app_security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.blue.arn
    container_name   = "api"
    container_port   = var.api_container_port
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count, load_balancer]
  }

  depends_on = [aws_lb_listener.prod]
}

resource "aws_ecs_service" "worker" {
  name            = "${var.name_prefix}-worker"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.app_security_group_id]
    assign_public_ip = false
  }
}

resource "aws_codedeploy_app" "ecs" {
  compute_platform = "ECS"
  name             = "${var.name_prefix}-codedeploy"
}

resource "aws_iam_role" "codedeploy" {
  name = "${var.name_prefix}-codedeploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "codedeploy.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "codedeploy" {
  role       = aws_iam_role.codedeploy.name
  policy_arn = "arn:aws:iam::aws:policy/AWSCodeDeployRoleForECS"
}

resource "aws_codedeploy_deployment_group" "api" {
  app_name              = aws_codedeploy_app.ecs.name
  deployment_group_name = "${var.name_prefix}-api"
  service_role_arn      = aws_iam_role.codedeploy.arn
  deployment_config_name = "CodeDeployDefault.ECSAllAtOnce"

  blue_green_deployment_config {
    deployment_ready_option {
      action_on_timeout = "CONTINUE_DEPLOYMENT"
    }

    terminate_blue_instances_on_deployment_success {
      action                           = "TERMINATE"
      termination_wait_time_in_minutes = 5
    }
  }

  auto_rollback_configuration {
    enabled = true
    events  = ["DEPLOYMENT_FAILURE", "DEPLOYMENT_STOP_ON_ALARM", "DEPLOYMENT_STOP_ON_REQUEST"]
  }

  ecs_service {
    cluster_name = aws_ecs_cluster.this.name
    service_name = aws_ecs_service.api.name
  }

  load_balancer_info {
    target_group_pair_info {
      prod_traffic_route {
        listener_arns = [aws_lb_listener.prod.arn]
      }

      test_traffic_route {
        listener_arns = [aws_lb_listener.test.arn]
      }

      target_group {
        name = aws_lb_target_group.blue.name
      }

      target_group {
        name = aws_lb_target_group.green.name
      }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${var.name_prefix}-api-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 5
  alarm_description   = "High 5xx rate on API target group"

  dimensions = {
    LoadBalancer = aws_lb.this.arn_suffix
    TargetGroup  = aws_lb_target_group.blue.arn_suffix
  }

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "api_cpu" {
  alarm_name          = "${var.name_prefix}-api-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "API ECS service CPU above 80%"

  dimensions = {
    ClusterName = aws_ecs_cluster.this.name
    ServiceName = aws_ecs_service.api.name
  }

  tags = var.tags
}
