# The money path: one Lambda behind the existing CloudFront distribution at
# /api/*, plus the secret it reads and the permissions it needs.
#
# Nothing here caches and nothing here is stateful. The Lambda's only durable
# inputs are the Stripe secret and the catalog the site build publishes, so a
# new album goes on sale with a site deploy and this stack stays untouched.

# ---------- Secrets ----------

# SSM SecureString rather than Secrets Manager. Both encrypt with KMS and gate
# on IAM identically; Secrets Manager additionally bills $0.40/secret/month for
# managed rotation, cross-region replication, and resource policies, none of
# which this uses — rotation here is pasting a new key from the Stripe
# dashboard. At ~283 bytes against the 4 KB standard-tier limit, this is free.

# Created holding `{}` on purpose. Stripe keys must never pass through Terraform
# state, so the real value is written out-of-band — see the README's go-live
# checklist — and ignored here forever after. Until it is populated the Lambda
# answers 500 and nothing sells.
resource "aws_ssm_parameter" "commerce" {
  name        = "/${var.name}/commerce"
  description = "Stripe restricted API key, webhook signing secret, and download token key"
  type        = "SecureString"
  tier        = "Standard"
  value       = "{}"
  tags        = local.tags

  lifecycle {
    ignore_changes = [value]
  }
}

# Test-mode keys for `bun run commerce:dev`, so local development needs no key
# on disk. Deliberately a second parameter rather than more fields in the one
# above: the deployed Lambda's IAM policy names only the production parameter,
# so it cannot read this, and local development cannot reach live keys.
resource "aws_ssm_parameter" "commerce_test" {
  name        = "/${var.name}/commerce-test"
  description = "Stripe TEST keys for local development. Never read by the deployed Lambda."
  type        = "SecureString"
  tier        = "Standard"
  value       = "{}"
  tags        = local.tags

  lifecycle {
    ignore_changes = [value]
  }
}

# SecureString values are encrypted under the account's default SSM key. Its key
# policy cannot be edited, so the decrypt grant has to be scoped from the IAM
# side instead — see the ViaService condition below.
data "aws_kms_alias" "ssm" {
  name = "alias/aws/ssm"
}

# The one shared secret Terraform does hold. CloudFront has to send it as an
# origin header and the Lambda has to compare against it, so a single generator
# is the only way both agree; putting it in Parameter Store instead would mean
# reading it back into state anyway. It authenticates a hop between two things
# in this account, not access to Stripe.
resource "random_password" "edge_secret" {
  length  = 48
  special = false
}

# ---------- Lambda ----------

data "archive_file" "commerce" {
  type        = "zip"
  source_file = "${path.module}/../dist-lambda/index.mjs"
  output_path = "${path.module}/../dist-lambda/commerce.zip"
}

data "aws_iam_policy_document" "commerce_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "commerce" {
  name               = "${var.name}-commerce"
  assume_role_policy = data.aws_iam_policy_document.commerce_trust.json
  tags               = local.tags
}

data "aws_iam_policy_document" "commerce" {
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

  # Reading a SecureString needs the decrypt too. The default SSM key takes no
  # key policy of its own, so this is where it gets constrained: only through
  # SSM, never as a general-purpose decrypt grant.
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

  # Presigning is a local signing operation, but the role still needs the
  # permission it signs for, or the presigned URL 403s when redeemed.
  statement {
    sid       = "PresignOriginals"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.originals.arn}/albums/*"]
  }

  # One object, not the bucket: the catalog is all the Lambda needs from the
  # site, and it has no business reading the rest of what CloudFront serves.
  statement {
    sid       = "ReadDownloadCatalog"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/downloads-catalog.json"]
  }
}

resource "aws_iam_role_policy" "commerce" {
  name   = "${var.name}-commerce"
  role   = aws_iam_role.commerce.id
  policy = data.aws_iam_policy_document.commerce.json
}

# Delivery email is optional: with no verified SES identity the Lambda logs a
# warning and the buyer still gets their file from the landing page. This grant
# only appears once an address is configured, and is pinned to that address.
data "aws_iam_policy_document" "commerce_email" {
  count = var.commerce_from_email == "" ? 0 : 1

  statement {
    sid       = "SendDeliveryEmail"
    actions   = ["ses:SendEmail"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [var.commerce_from_email]
    }
  }
}

resource "aws_iam_role_policy" "commerce_email" {
  count  = var.commerce_from_email == "" ? 0 : 1
  name   = "${var.name}-commerce-email"
  role   = aws_iam_role.commerce.id
  policy = data.aws_iam_policy_document.commerce_email[0].json
}

# Bounded retention, matching the site's other logs: these carry order ids.
resource "aws_cloudwatch_log_group" "commerce" {
  name              = "/aws/lambda/${var.name}-commerce"
  retention_in_days = 30
  tags              = local.tags
}

resource "aws_lambda_function" "commerce" {
  function_name = "${var.name}-commerce"
  role          = aws_iam_role.commerce.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]
  memory_size   = 512

  # Long enough for a cold start plus a Stripe round trip, short enough that a
  # hung call fails rather than sitting on the buyer's redirect.
  timeout = 15

  # A portfolio store needs no more, and it caps what a flood against the
  # Function URL can cost before CloudFront's own limits engage.
  reserved_concurrent_executions = 10

  filename         = data.archive_file.commerce.output_path
  source_code_hash = data.archive_file.commerce.output_base64sha256
  tags             = local.tags

  environment {
    variables = {
      COMMERCE_SECRET_PARAM = aws_ssm_parameter.commerce.name
      ORIGINALS_BUCKET      = aws_s3_bucket.originals.bucket
      SITE_BUCKET           = aws_s3_bucket.site.bucket
      SITE_URL              = "https://${var.domain_name}"
      FROM_EMAIL            = var.commerce_from_email
      EDGE_SECRET           = random_password.edge_secret.result
    }
  }

  depends_on = [aws_cloudwatch_log_group.commerce]
}

# AuthType NONE rather than AWS_IAM with OAC. OAC would be stronger, but it
# requires the caller to sign POST bodies with an x-amz-content-sha256 header,
# and Stripe's webhook sender knows nothing about that. The origin header below
# is what takes its place; the webhook's real guarantee is its own signature.
resource "aws_lambda_function_url" "commerce" {
  function_name      = aws_lambda_function.commerce.function_name
  authorization_type = "NONE"
}

# ---------- Alarm ----------

# The one failure here that costs money silently. A webhook that 500s makes
# Stripe retry and then give up, so a buyer pays and never receives their file,
# and nothing on this side says so — the Lambda's own logs are the only trace,
# and nobody reads logs they have no reason to open.
#
# Free: one alarm sits inside the CloudWatch free allowance, and SNS email is
# well within its own.
resource "aws_sns_topic" "commerce_alarms" {
  name = "${var.name}-commerce-alarms"
  tags = local.tags
}

# Confirm this by clicking the link AWS emails on first apply; until then the
# alarm fires into a subscription that delivers nowhere.
resource "aws_sns_topic_subscription" "commerce_alarms" {
  topic_arn = aws_sns_topic.commerce_alarms.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_metric_alarm" "commerce_errors" {
  alarm_name        = "${var.name}-commerce-errors"
  alarm_description = "The commerce Lambda threw. A buyer may have paid without being delivered."
  namespace         = "AWS/Lambda"
  metric_name       = "Errors"
  dimensions        = { FunctionName = aws_lambda_function.commerce.function_name }

  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"

  # A quiet function reports no datapoints at all, which is the normal state
  # here and must not read as a failure.
  treat_missing_data = "notBreaching"

  alarm_actions = [aws_sns_topic.commerce_alarms.arn]
  ok_actions    = [aws_sns_topic.commerce_alarms.arn]
  tags          = local.tags
}

# ---------- CloudFront wiring ----------

locals {
  commerce_origin_domain = replace(
    replace(aws_lambda_function_url.commerce.function_url, "https://", ""),
    "/",
    "",
  )
}

output "commerce_secret_param" {
  value = aws_ssm_parameter.commerce.name
}

output "commerce_test_secret_param" {
  description = "Test-mode keys read by `bun run commerce:dev`"
  value       = aws_ssm_parameter.commerce_test.name
}

output "commerce_webhook_url" {
  description = "Register this as the Stripe webhook endpoint"
  value       = "https://${var.domain_name}/api/stripe/webhook"
}
