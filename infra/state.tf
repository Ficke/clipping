# Remote Terraform state, so infra stays manageable if this machine is lost.
#
# Bootstrap (one-time): this bucket is created while state is still local,
# then `terraform init -migrate-state` moves state into it (backend.tf).

resource "aws_s3_bucket" "tfstate" {
  bucket = "${var.name}-tfstate"
  tags   = local.tags

  # Losing this bucket orphans every resource in the stack.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
