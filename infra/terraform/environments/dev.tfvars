environment          = "dev"
aws_region           = "ap-south-1"
availability_zones   = ["ap-south-1a", "ap-south-1b"]
vpc_cidr             = "10.40.0.0/16"
public_subnet_cidrs  = ["10.40.0.0/24", "10.40.1.0/24"]
private_subnet_cidrs = ["10.40.10.0/24", "10.40.11.0/24"]

db_username = "medsys"
db_password = "replace-me"

api_image    = "000000000000.dkr.ecr.ap-south-1.amazonaws.com/medsys-dev-api:latest"
worker_image = "000000000000.dkr.ecr.ap-south-1.amazonaws.com/medsys-dev-worker:latest"

jwt_access_public_key    = "replace-me"
jwt_access_private_key   = "replace-me"
jwt_refresh_public_key   = "replace-me"
jwt_refresh_private_key  = "replace-me"
