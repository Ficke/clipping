# The access-logs bucket has carried a TLS-only deny since it was created
# (logging.tf). These three carry no policy otherwise, so the deny is the whole
# policy. The site and media buckets get the same statement appended to the
# CloudFront read policies they already have.

locals {
  tls_only_buckets = {
    originals = { id = aws_s3_bucket.originals.id, arn = aws_s3_bucket.originals.arn }
    builds    = { id = aws_s3_bucket.builds.id, arn = aws_s3_bucket.builds.arn }
    tfstate   = { id = aws_s3_bucket.tfstate.id, arn = aws_s3_bucket.tfstate.arn }
  }
}

data "aws_iam_policy_document" "tls_only" {
  for_each = local.tls_only_buckets

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [each.value.arn, "${each.value.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "tls_only" {
  for_each = local.tls_only_buckets

  bucket = each.value.id
  policy = data.aws_iam_policy_document.tls_only[each.key].json
}
