terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.80"
    }

    # Zips the bundled commerce Lambda; generates the CloudFront origin secret.
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.4"
    }

    random = {
      source  = "hashicorp/random"
      version = ">= 3.6"
    }
  }
}

# us-east-1: required region for CloudFront-attached ACM certs; the site has no
# regional footprint beyond the bucket, so everything lives here.
provider "aws" {
  region = "us-east-1"
}
