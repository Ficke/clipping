# The money path: one Lambda behind the existing CloudFront distribution at
# /api/*, plus the secret it reads and the permissions it needs.
#
# Nothing here caches and nothing here is stateful. The Lambda's only durable
# inputs are the Stripe secret and the catalog the site build publishes, so a
# new album goes on sale with a site deploy and this stack stays untouched.

# ---------- Secrets ----------

# Created empty on purpose. Stripe keys must never pass through Terraform
# state, so the value is written out-of-band — see the README's go-live
# checklist. Until it is populated the Lambda answers 500 and nothing sells.
resource "aws_secretsmanager_secret" "commerce" {
  name        = "${var.name}-commerce"
  description = "Stripe restricted API key, webhook signing secret, and download token key"
  tags        = local.tags

  # Long enough to notice a mistaken destroy, short enough that the name frees
  # up without a support ticket.
  recovery_window_in_days = 7
}

# The one shared secret Terraform does hold. CloudFront has to send it as an
# origin header and the Lambda has to compare against it, so a single generator
# is the only way both agree; putting it in Secrets Manager instead would mean
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
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.commerce.arn]
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
      COMMERCE_SECRET_ID = aws_secretsmanager_secret.commerce.name
      ORIGINALS_BUCKET   = aws_s3_bucket.originals.bucket
      SITE_BUCKET        = aws_s3_bucket.site.bucket
      SITE_URL           = "https://${var.domain_name}"
      FROM_EMAIL         = var.commerce_from_email
      EDGE_SECRET        = random_password.edge_secret.result
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

# ---------- CloudFront wiring ----------

locals {
  commerce_origin_domain = replace(
    replace(aws_lambda_function_url.commerce.function_url, "https://", ""),
    "/",
    "",
  )
}

output "commerce_secret_name" {
  value = aws_secretsmanager_secret.commerce.name
}

output "commerce_webhook_url" {
  description = "Register this as the Stripe webhook endpoint"
  value       = "https://${var.domain_name}/api/stripe/webhook"
}
