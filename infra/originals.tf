# Canonical archive for full-quality masters. The separate media build reads
# these objects; the site build reads only manifests committed to Git.

resource "aws_s3_bucket" "originals" {
  bucket = "${var.name}-originals"
  tags   = local.tags

  # Git holds no master images, so this bucket is their sole durable location.
  # Versioning covers object changes; this guard covers the bucket itself.
  lifecycle {
    prevent_destroy = true
  }
}

# Overwrites and deletes are recoverable — this bucket is the archive.
resource "aws_s3_bucket_versioning" "originals" {
  bucket = aws_s3_bucket.originals.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "originals" {
  bucket                  = aws_s3_bucket.originals.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Expire old versions after 90 days so edit/replace churn doesn't accrue forever.
resource "aws_s3_bucket_lifecycle_configuration" "originals" {
  bucket = aws_s3_bucket.originals.id
  rule {
    id     = "expire-noncurrent"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

output "originals_bucket" {
  value = aws_s3_bucket.originals.bucket
}
