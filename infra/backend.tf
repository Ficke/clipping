# Remote state with native S3 lockfiles (Terraform >= 1.10) — no DynamoDB.
# The bucket is defined in state.tf, which documents the one-time bootstrap.

terraform {
  backend "s3" {
    bucket       = "adamficke-com-tfstate"
    key          = "site/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true
  }
}
