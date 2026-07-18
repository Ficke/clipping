terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.80"
    }
  }
}

# us-east-1: required region for CloudFront-attached ACM certs; the site has no
# regional footprint beyond the bucket, so everything lives here.
provider "aws" {
  region = "us-east-1"
}
