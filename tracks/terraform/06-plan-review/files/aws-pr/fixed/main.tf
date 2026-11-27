terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

provider "aws" {
  region                      = "eu-west-1"
  access_key                  = "mock"
  secret_key                  = "mock"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
}

locals {
  tags = { app = "shop", env = "prod", owner = "platform", cost_center = "cc-1234" }
}

resource "aws_security_group" "db" {
  name        = "shop-prod-db"
  description = "Postgres for the shop"
  vpc_id      = "vpc-0a1b2c3d4e5f60718"
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  security_group_id = aws_security_group.db.id
  cidr_ipv4         = "10.20.8.0/21"
  from_port         = 5432
  to_port           = 5432
  ip_protocol       = "tcp"
}

resource "aws_db_instance" "main" {
  identifier                  = "shop-prod-db"
  engine                      = "postgres"
  engine_version              = "17.2"
  allow_major_version_upgrade = true
  instance_class              = "db.t4g.medium"
  allocated_storage           = 100
  storage_encrypted           = false # encryption at rest: planned migration SEC-89 (snapshot, encrypted copy, restore)
  username                    = "shop"
  manage_master_user_password = true
  vpc_security_group_ids      = [aws_security_group.db.id]
  backup_retention_period     = 7
  deletion_protection         = true
  skip_final_snapshot         = false
  final_snapshot_identifier   = "shop-prod-db-final"
  tags                        = local.tags
}

module "assets" {
  source = "./modules/bucket"
  name   = "shop-prod-assets-example"
  tags   = local.tags
}

moved {
  from = aws_s3_bucket.assets
  to   = module.assets.aws_s3_bucket.this
}

moved {
  from = aws_s3_bucket_versioning.assets
  to   = module.assets.aws_s3_bucket_versioning.this
}

resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  alarm_name          = "shop-prod-db-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  tags                = local.tags
}

resource "aws_instance" "web" {
  ami                    = "ami-0c1d2e3f4a5b6c7d8"
  instance_type          = "t3.medium"
  subnet_id              = "subnet-0123456789abcdef0"
  vpc_security_group_ids = ["sg-0fedcba9876543210"]
  tags                   = merge(local.tags, { Name = "shop-prod-web" })
}
