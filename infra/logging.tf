# CloudFront standard logging v2. Logs are retained indefinitely; no lifecycle
# expiration is configured. The selected fields intentionally omit viewer IPs,
# query strings, forwarded-for values, and cookies.

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "access_logs" {
  bucket = "${var.name}-access-logs"
  tags   = local.tags
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  bucket                  = aws_s3_bucket.access_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "access_logs" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.access_logs.arn,
      "${aws_s3_bucket.access_logs.arn}/*",
    ]

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

  statement {
    sid       = "AWSLogsDeliveryWrite"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.access_logs.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:logs:us-east-1:${data.aws_caller_identity.current.account_id}:delivery-source:*"]
    }
  }
}

resource "aws_s3_bucket_policy" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  policy = data.aws_iam_policy_document.access_logs.json
}

resource "aws_cloudwatch_log_delivery_source" "cloudfront" {
  name         = "${var.name}-cloudfront-access"
  log_type     = "ACCESS_LOGS"
  resource_arn = aws_cloudfront_distribution.site.arn
  tags         = local.tags
}

resource "aws_cloudwatch_log_delivery_destination" "cloudfront_s3" {
  name          = "${var.name}-cloudfront-s3"
  output_format = "w3c"
  tags          = local.tags

  delivery_destination_configuration {
    destination_resource_arn = aws_s3_bucket.access_logs.arn
  }
}

resource "aws_cloudwatch_log_delivery" "cloudfront_s3" {
  delivery_source_name     = aws_cloudwatch_log_delivery_source.cloudfront.name
  delivery_destination_arn = aws_cloudwatch_log_delivery_destination.cloudfront_s3.arn
  field_delimiter          = "\t"

  record_fields = [
    "date",
    "time",
    "x-edge-location",
    "sc-bytes",
    "cs-method",
    "cs(Host)",
    "cs-uri-stem",
    "sc-status",
    "cs(Referer)",
    "cs(User-Agent)",
    "x-edge-result-type",
    "x-edge-request-id",
    "x-host-header",
    "cs-protocol",
    "cs-bytes",
    "time-taken",
    "ssl-protocol",
    "ssl-cipher",
    "x-edge-response-result-type",
    "cs-protocol-version",
    "time-to-first-byte",
    "x-edge-detailed-result-type",
    "sc-content-type",
    "sc-content-len",
    "c-country",
    "cache-behavior-path-pattern",
  ]

  s3_delivery_configuration {
    enable_hive_compatible_path = true
    suffix_path                 = "distribution/{distributionid}/{yyyy}/{MM}/{dd}/{HH}"
  }

  depends_on = [
    aws_s3_bucket_policy.access_logs,
    aws_s3_bucket_ownership_controls.access_logs,
  ]
}
