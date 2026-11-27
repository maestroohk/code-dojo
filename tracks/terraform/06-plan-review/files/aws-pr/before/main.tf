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
  tags = { app = "shop", env = "prod", owner = "platform" }
}

resource "aws_security_group" "db" {
  name        = "shop-prod-db"
  description = "Postgres for the shop"
  vpc_id      = "vpc-0a1b2c3d4e5f60718"
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  security_group_id = aws_security_group.db.id
  cidr_ipv4         = "10.20.0.0/16"
  from_port         = 5432
  to_port           = 5432
  ip_protocol       = "tcp"
}

resource "aws_db_instance" "main" {
  identifier             = "shop-prod-db"
  engine                 = "postgres"
  engine_version         = "16.4"
  instance_class         = "db.t4g.medium"
  allocated_storage      = 100
  storage_encrypted      = false
  username               = "shop"
  manage_master_user_password = true
  vpc_security_group_ids = [aws_security_group.db.id]
  backup_retention_period = 7
  deletion_protection    = false
  skip_final_snapshot    = true
  tags                   = local.tags
}

resource "aws_s3_bucket" "assets" {
  bucket = "shop-prod-assets-example"
  tags   = local.tags
}

resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_instance" "web" {
  ami                    = "ami-0c1d2e3f4a5b6c7d8"
  instance_type          = "t3.small"
  subnet_id              = "subnet-0123456789abcdef0"
  vpc_security_group_ids = ["sg-0fedcba9876543210"]
  tags                   = merge(local.tags, { Name = "shop-prod-web" })
}
