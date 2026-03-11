environment           = "prod"
aws_region            = "ap-south-1"
availability_zones    = ["ap-south-1a", "ap-south-1b", "ap-south-1c"]
vpc_cidr              = "10.60.0.0/16"
public_subnet_cidrs   = ["10.60.0.0/24", "10.60.1.0/24", "10.60.2.0/24"]
private_subnet_cidrs  = ["10.60.10.0/24", "10.60.11.0/24", "10.60.12.0/24"]

db_username = "medsys"
db_password = "replace-me"

db_instance_class         = "db.r6g.xlarge"
cache_node_type           = "cache.r6g.large"
opensearch_instance_type  = "m6g.large.search"
opensearch_instance_count = 3
api_desired_count         = 3
worker_desired_count      = 2

api_image    = "000000000000.dkr.ecr.ap-south-1.amazonaws.com/medsys-prod-api:latest"
worker_image = "000000000000.dkr.ecr.ap-south-1.amazonaws.com/medsys-prod-worker:latest"

jwt_access_public_key    = "replace-me"
jwt_access_private_key   = "replace-me"
jwt_refresh_public_key   = "replace-me"
jwt_refresh_private_key  = "replace-me"
