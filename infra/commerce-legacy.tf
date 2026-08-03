# Temporary M5-M7 rollback rail.
#
# The durable commerce cutover moves CloudFront's /api/* behavior to the new
# HTTP API, but the previously deployed stateless Lambda runtime stays intact
# until the controlled live drill succeeds. Keeping these resources managed
# makes rollback a CloudFront origin change instead of a runtime reconstruction.
# Remove this file only at the documented M7 cleanup gate.

resource "aws_cloudfront_origin_access_control" "commerce" {
  name                              = "${var.name}-commerce"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"

  lifecycle {
    prevent_destroy = true
  }
}

data "aws_iam_policy_document" "commerce_legacy" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.commerce.arn}:*"]
  }

  statement {
    sid       = "ReadCommerceSecret"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.commerce.arn]
  }

  statement {
    sid       = "DecryptCommerceSecret"
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_alias.ssm.target_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.us-east-1.amazonaws.com"]
    }
  }

  statement {
    sid       = "PresignOriginals"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.originals.arn}/albums/*"]
  }

  statement {
    sid       = "ReadDownloadCatalog"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/downloads-catalog.json"]
  }
}

resource "aws_iam_role" "commerce" {
  name               = "${var.name}-commerce"
  assume_role_policy = data.aws_iam_policy_document.commerce_lambda_trust.json
  tags               = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_iam_role_policy" "commerce" {
  name   = "${var.name}-commerce"
  role   = aws_iam_role.commerce.id
  policy = data.aws_iam_policy_document.commerce_legacy.json

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_cloudwatch_log_group" "commerce" {
  name              = "/aws/lambda/${var.name}-commerce"
  retention_in_days = 30
  tags              = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

# This read is a guard: the rollback rail must already exist. If it has been
# removed out of band, planning fails instead of creating the old function name
# with the new Buyer's package.
data "aws_lambda_function" "commerce_legacy" {
  function_name = "${var.name}-commerce"
}

resource "aws_lambda_function" "commerce" {
  function_name = "${var.name}-commerce"
  role          = aws_iam_role.commerce.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]
  memory_size   = 512
  timeout       = 15

  # Terraform requires a package source in configuration. The deployed legacy
  # bytes and every other function attribute are deliberately frozen below, so
  # this package is never uploaded to the retained function.
  filename         = data.archive_file.commerce_buyer.output_path
  source_code_hash = data.archive_file.commerce_buyer.output_base64sha256
  tags             = local.tags

  environment {
    variables = {
      COMMERCE_SECRET_PARAM = aws_ssm_parameter.commerce.name
      ORIGINALS_BUCKET      = aws_s3_bucket.originals.bucket
      SITE_BUCKET           = aws_s3_bucket.site.bucket
      SITE_URL              = "https://${var.domain_name}"
    }
  }

  lifecycle {
    prevent_destroy = true
    ignore_changes  = all
  }

  depends_on = [
    aws_cloudwatch_log_group.commerce,
    data.aws_lambda_function.commerce_legacy,
  ]
}

resource "aws_lambda_function_url" "commerce" {
  function_name      = aws_lambda_function.commerce.function_name
  authorization_type = "AWS_IAM"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_lambda_permission" "commerce_cloudfront_url" {
  statement_id           = "AllowCloudFrontFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.commerce.function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.site.arn
  function_url_auth_type = "AWS_IAM"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_lambda_permission" "commerce_cloudfront_invoke" {
  statement_id  = "AllowCloudFrontInvokeFunction"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.commerce.function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.site.arn

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_cloudwatch_metric_alarm" "commerce_errors" {
  alarm_name        = "${var.name}-commerce-errors"
  alarm_description = "The retained legacy commerce Lambda threw during checkout or download delivery."
  namespace         = "AWS/Lambda"
  metric_name       = "Errors"
  dimensions        = { FunctionName = aws_lambda_function.commerce.function_name }

  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.commerce_alarms.arn]
  ok_actions          = [aws_sns_topic.commerce_alarms.arn]
  tags                = local.tags

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [alarm_description]
  }
}
