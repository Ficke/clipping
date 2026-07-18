# Remote state with native S3 lockfiles (Terraform >= 1.10) — no DynamoDB.
# Bootstrapped 2026-07-18: the bucket (state.tf) was applied under local
# state, then `terraform init -migrate-state` moved state here.

terraform {
  backend "s3" {
    bucket       = "adamficke-com-tfstate"
    key          = "site/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true
  }
}
