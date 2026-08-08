resource "aws_s3_bucket" "builds" {
  bucket = "${var.name}-builds"
  tags   = local.tags
}

resource "aws_s3_bucket_public_access_block" "builds" {
  bucket                  = aws_s3_bucket.builds.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "builds" {
  bucket = aws_s3_bucket.builds.id

  rule {
    id     = "expire-build-sources"
    status = "Enabled"

    filter {
      prefix = "source/"
    }

    expiration {
      days = 7
    }
  }
}

resource "aws_cloudwatch_log_group" "site_build" {
  name              = "/aws/codebuild/${var.name}-site"
  retention_in_days = 14
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "media_build" {
  name              = "/aws/codebuild/${var.name}-media"
  retention_in_days = 14
  tags              = local.tags
}

data "aws_iam_policy_document" "codebuild_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "site_build" {
  name               = "${var.name}-site-build"
  assume_role_policy = data.aws_iam_policy_document.codebuild_trust.json
  tags               = local.tags
}

resource "aws_iam_role" "media_build" {
  name               = "${var.name}-media-build"
  assume_role_policy = data.aws_iam_policy_document.codebuild_trust.json
  tags               = local.tags
}

data "aws_iam_policy_document" "site_build" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.site_build.arn}:*"]
  }

  statement {
    sid       = "ReadSource"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.builds.arn}/source/*"]
  }

  statement {
    sid       = "ListSite"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.site.arn]
  }

  statement {
    sid       = "DeploySite"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"]
  }

  statement {
    sid       = "Invalidate"
    actions   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
    resources = [aws_cloudfront_distribution.site.arn]
  }

  statement {
    sid       = "ListMediaForCleanup"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.media.arn]
  }

  statement {
    sid       = "DeleteObsoleteMedia"
    actions   = ["s3:DeleteObject"]
    resources = ["${aws_s3_bucket.media.arn}/media/*"]
  }
}

resource "aws_iam_role_policy" "site_build" {
  name   = "build"
  role   = aws_iam_role.site_build.id
  policy = data.aws_iam_policy_document.site_build.json
}

data "aws_iam_policy_document" "media_build" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.media_build.arn}:*"]
  }

  statement {
    sid       = "ReadSource"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.builds.arn}/source/*"]
  }

  statement {
    sid       = "ListOriginals"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.originals.arn]
  }

  statement {
    sid       = "ReadOriginalsWriteManifests"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.originals.arn}/albums/*"]
  }

  statement {
    sid       = "PublishFulfillmentAssets"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.originals.arn}/fulfillment/*"]
  }

  statement {
    sid       = "WriteManifests"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.originals.arn}/manifests/*"]
  }

  statement {
    sid       = "ListMedia"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.media.arn]
  }

  statement {
    sid       = "PublishMedia"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.media.arn}/media/*"]
  }
}

resource "aws_iam_role_policy" "media_build" {
  name   = "build"
  role   = aws_iam_role.media_build.id
  policy = data.aws_iam_policy_document.media_build.json
}

resource "aws_codebuild_project" "site" {
  name          = "${var.name}-site"
  description   = "Build and deploy the Astro site"
  service_role  = aws_iam_role.site_build.arn
  build_timeout = 15
  tags          = local.tags

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    host_kernel                 = "LINUX_KERNEL_6"
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "SITE_BUCKET"
      value = aws_s3_bucket.site.bucket
    }

    environment_variable {
      name  = "CLOUDFRONT_DISTRIBUTION_ID"
      value = aws_cloudfront_distribution.site.id
    }

    environment_variable {
      name  = "MEDIA_BUCKET"
      value = aws_s3_bucket.media.bucket
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name = aws_cloudwatch_log_group.site_build.name
    }
  }

  source {
    type      = "NO_SOURCE"
    buildspec = file("${path.module}/../buildspec-site.yml")
  }
}

resource "aws_codebuild_project" "media" {
  name          = "${var.name}-media"
  description   = "Generate immutable photo derivatives one album at a time"
  service_role  = aws_iam_role.media_build.arn
  build_timeout = 60
  tags          = local.tags

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    host_kernel                 = "LINUX_KERNEL_6"
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "MEDIA_BUCKET"
      value = aws_s3_bucket.media.bucket
    }

    environment_variable {
      name  = "MANIFEST_BUCKET"
      value = aws_s3_bucket.originals.bucket
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name = aws_cloudwatch_log_group.media_build.name
    }
  }

  source {
    type      = "NO_SOURCE"
    buildspec = file("${path.module}/../buildspec-media.yml")
  }
}

output "build_bucket" {
  value = aws_s3_bucket.builds.bucket
}

output "site_build_project" {
  value = aws_codebuild_project.site.name
}

output "media_build_project" {
  value = aws_codebuild_project.media.name
}
