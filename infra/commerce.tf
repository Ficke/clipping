# Stripe commerce infrastructure: durable orders, isolated request-path
# functions, and an origin-authorized REST API behind the existing CloudFront
# distribution. The previously deployed HTTP API remains as a rollback rail.

# Proof that a request arrived through CloudFront rather than straight at
# execute-api. The gateway authorizer rejects before Buyer is ever invoked,
# which is what protects its reserved concurrency; the handlers re-check the
# same header so a misconfigured authorizer cannot silently open the API.
#
# Two secrets exist so rotation never drops a request: both are always
# accepted, and `commerce_origin_verify_active` decides which one CloudFront
# sends. Flip it, apply, and let the distribution propagate — nothing 403s,
# because the value it stops sending is still honored. Regenerate the retired
# one afterwards with `-replace`.
#
# They are generated here, not supplied: the value lands in state either way,
# so an out-of-band secret buys nothing and costs a recovery step per apply.
resource "random_password" "commerce_origin_verify" {
  length = 48
  # Alphanumeric: this value is interpolated into the authorizer's identity
  # validation regex, where a metacharacter would silently change the match.
  special = false
}

resource "random_password" "commerce_origin_verify_next" {
  length  = 48
  special = false
}

locals {
  commerce_origin_verify_accepted = [
    random_password.commerce_origin_verify.result,
    random_password.commerce_origin_verify_next.result,
  ]

  commerce_origin_verify_active = (
    var.commerce_origin_verify_active == "next"
    ? random_password.commerce_origin_verify_next.result
    : random_password.commerce_origin_verify.result
  )
}

# ---------- Secrets ----------

# These parameters are created with placeholders so live credentials never
# pass through Terraform state. Populate them out of band after the first apply.
resource "aws_ssm_parameter" "commerce" {
  name        = "/${var.name}/commerce"
  description = "Stripe restricted API key, Managed Payments Product ID, and download token key"
  type        = "SecureString"
  tier        = "Standard"
  value       = "{}"
  tags        = local.tags

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "commerce_webhook" {
  name        = "/${var.name}/commerce-webhook"
  description = "Stripe webhook signing secret and restricted read key"
  type        = "SecureString"
  tier        = "Standard"
  value       = "{}"
  tags        = local.tags

  lifecycle {
    ignore_changes = [value]
  }
}

# Test-mode keys for local development. Neither deployed Lambda can read this
# parameter.
resource "aws_ssm_parameter" "commerce_test" {
  name        = "/${var.name}/commerce-test"
  description = "Stripe TEST key, sandbox Product ID, and token key for local development. Never read by the deployed Lambda."
  type        = "SecureString"
  tier        = "Standard"
  value       = "{}"
  tags        = local.tags

  lifecycle {
    ignore_changes = [value]
  }
}

data "aws_kms_alias" "ssm" {
  name = "alias/aws/ssm"
}

# ---------- Orders ----------

resource "aws_dynamodb_table" "commerce_orders" {
  name         = "${var.name}-commerce-orders"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "orderId"
  tags         = local.tags

  attribute {
    name = "orderId"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  ttl {
    attribute_name = "deleteAfter"
    enabled        = true
  }
}

# ---------- Lambda packages ----------

data "archive_file" "commerce_buyer" {
  type        = "zip"
  source_file = "${path.module}/../dist-lambda/buyer/index.mjs"
  output_path = "${path.module}/../dist-lambda/commerce-buyer.zip"
}

data "archive_file" "commerce_webhook" {
  type        = "zip"
  source_file = "${path.module}/../dist-lambda/webhook/index.mjs"
  output_path = "${path.module}/../dist-lambda/commerce-webhook.zip"
}

data "archive_file" "commerce_authorizer" {
  type        = "zip"
  source_file = "${path.module}/../dist-lambda/authorizer/index.mjs"
  output_path = "${path.module}/../dist-lambda/commerce-authorizer.zip"
}

data "aws_iam_policy_document" "commerce_lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ---------- Buyer Lambda ----------

resource "aws_iam_role" "commerce_buyer" {
  name               = "${var.name}-commerce-buyer"
  assume_role_policy = data.aws_iam_policy_document.commerce_lambda_trust.json
  tags               = local.tags
}

data "aws_iam_policy_document" "commerce_buyer" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.commerce_buyer.arn}:*"]
  }

  statement {
    sid       = "ReadBuyerSecret"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.commerce.arn]
  }

  statement {
    sid       = "DecryptBuyerSecret"
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_alias.ssm.target_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.us-east-1.amazonaws.com"]
    }
  }

  statement {
    sid = "ReadWriteOrders"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]
    resources = [aws_dynamodb_table.commerce_orders.arn]
  }

  # Presigning happens locally, but the role must hold the permission carried
  # by the generated URL.
  statement {
    sid       = "PresignFulfillmentAssets"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.originals.arn}/fulfillment/*"]
  }

  statement {
    sid       = "ReadDownloadCatalog"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/downloads-catalog.json"]
  }
}

resource "aws_iam_role_policy" "commerce_buyer" {
  name   = "${var.name}-commerce-buyer"
  role   = aws_iam_role.commerce_buyer.id
  policy = data.aws_iam_policy_document.commerce_buyer.json
}

resource "aws_cloudwatch_log_group" "commerce_buyer" {
  name              = "/aws/lambda/${var.name}-commerce-buyer"
  retention_in_days = 30
  tags              = local.tags
}

resource "aws_lambda_function" "commerce_buyer" {
  function_name = "${var.name}-commerce-buyer"
  role          = aws_iam_role.commerce_buyer.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]
  memory_size   = 512
  timeout       = 15
  # Gate A proceeded against the account's shared ten-unit pool. Enable the
  # separate 5/3/2 isolation gate once at least 110 account units are applied;
  # the current applied quota is 1000.
  reserved_concurrent_executions = var.commerce_reserved_concurrency_enabled ? 5 : null

  filename         = data.archive_file.commerce_buyer.output_path
  source_code_hash = data.archive_file.commerce_buyer.output_base64sha256
  tags             = local.tags

  environment {
    variables = {
      COMMERCE_SECRET_PARAM     = aws_ssm_parameter.commerce.name
      COMMERCE_TABLE            = aws_dynamodb_table.commerce_orders.name
      ORIGINALS_BUCKET          = aws_s3_bucket.originals.bucket
      SITE_BUCKET               = aws_s3_bucket.site.bucket
      SITE_URL                  = "https://${var.domain_name}"
      ORIGIN_VERIFY_HEADER_NAME = var.commerce_origin_verify_header_name
      # Not a secret store: this only distinguishes CloudFront from direct
      # execute-api callers, and the REST authorizer is the actual gate. Stripe
      # keys stay in SSM for the reason config.ts gives.
      ORIGIN_VERIFY_HEADER_VALUES = join(",", local.commerce_origin_verify_accepted)
    }
  }

  depends_on = [aws_cloudwatch_log_group.commerce_buyer]
}

# ---------- Webhook Lambda ----------

resource "aws_iam_role" "commerce_webhook" {
  name               = "${var.name}-commerce-webhook"
  assume_role_policy = data.aws_iam_policy_document.commerce_lambda_trust.json
  tags               = local.tags
}

data "aws_iam_policy_document" "commerce_webhook" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.commerce_webhook.arn}:*"]
  }

  statement {
    sid       = "ReadWebhookSecret"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.commerce_webhook.arn]
  }

  statement {
    sid       = "DecryptWebhookSecret"
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_alias.ssm.target_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.us-east-1.amazonaws.com"]
    }
  }

  statement {
    sid = "ReadWriteOrders"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:UpdateItem",
    ]
    resources = [aws_dynamodb_table.commerce_orders.arn]
  }
}

resource "aws_iam_role_policy" "commerce_webhook" {
  name   = "${var.name}-commerce-webhook"
  role   = aws_iam_role.commerce_webhook.id
  policy = data.aws_iam_policy_document.commerce_webhook.json
}

resource "aws_cloudwatch_log_group" "commerce_webhook" {
  name              = "/aws/lambda/${var.name}-commerce-webhook"
  retention_in_days = 30
  tags              = local.tags
}

resource "aws_lambda_function" "commerce_webhook" {
  function_name                  = "${var.name}-commerce-webhook"
  role                           = aws_iam_role.commerce_webhook.arn
  handler                        = "index.handler"
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  memory_size                    = 512
  timeout                        = 15
  reserved_concurrent_executions = var.commerce_reserved_concurrency_enabled ? 3 : null

  filename         = data.archive_file.commerce_webhook.output_path
  source_code_hash = data.archive_file.commerce_webhook.output_base64sha256
  tags             = local.tags

  environment {
    variables = {
      COMMERCE_WEBHOOK_SECRET_PARAM = aws_ssm_parameter.commerce_webhook.name
      COMMERCE_TABLE                = aws_dynamodb_table.commerce_orders.name
      ORIGIN_VERIFY_HEADER_NAME     = var.commerce_origin_verify_header_name
      ORIGIN_VERIFY_HEADER_VALUES   = join(",", local.commerce_origin_verify_accepted)
    }
  }

  depends_on = [aws_cloudwatch_log_group.commerce_webhook]
}

# ---------- Origin authorizer Lambda ----------

resource "aws_iam_role" "commerce_authorizer" {
  name               = "${var.name}-commerce-authorizer"
  assume_role_policy = data.aws_iam_policy_document.commerce_lambda_trust.json
  tags               = local.tags
}

data "aws_iam_policy_document" "commerce_authorizer" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.commerce_authorizer.arn}:*"]
  }
}

resource "aws_iam_role_policy" "commerce_authorizer" {
  name   = "${var.name}-commerce-authorizer"
  role   = aws_iam_role.commerce_authorizer.id
  policy = data.aws_iam_policy_document.commerce_authorizer.json
}

resource "aws_cloudwatch_log_group" "commerce_authorizer" {
  name              = "/aws/lambda/${var.name}-commerce-authorizer"
  retention_in_days = 30
  tags              = local.tags
}

resource "aws_lambda_function" "commerce_authorizer" {
  function_name = "${var.name}-commerce-authorizer"
  role          = aws_iam_role.commerce_authorizer.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]
  memory_size   = 128
  timeout       = 3
  # Two slots prevent a simultaneous cold-cache request pair from turning the
  # authorizer into a single-invocation availability bottleneck.
  reserved_concurrent_executions = var.commerce_reserved_concurrency_enabled ? 2 : null

  filename         = data.archive_file.commerce_authorizer.output_path
  source_code_hash = data.archive_file.commerce_authorizer.output_base64sha256
  tags             = local.tags

  environment {
    variables = {
      ORIGIN_VERIFY_HEADER_VALUES = join(",", local.commerce_origin_verify_accepted)
    }
  }

  depends_on = [aws_cloudwatch_log_group.commerce_authorizer]
}

# ---------- Deployed HTTP API rollback rail ----------

resource "aws_apigatewayv2_api" "commerce" {
  name                         = "${var.name}-commerce"
  protocol_type                = "HTTP"
  disable_execute_api_endpoint = var.commerce_http_api_dormant
  tags                         = local.tags

  lifecycle {
    precondition {
      condition     = !var.commerce_http_api_dormant || var.commerce_rest_cutover_enabled
      error_message = "The HTTP API may become dormant only after CloudFront is configured for the REST API."
    }
  }
}

resource "aws_apigatewayv2_integration" "commerce_buyer" {
  api_id                 = aws_apigatewayv2_api.commerce.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.commerce_buyer.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
  timeout_milliseconds   = 15000
}

resource "aws_apigatewayv2_integration" "commerce_webhook" {
  api_id                 = aws_apigatewayv2_api.commerce.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.commerce_webhook.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
  timeout_milliseconds   = 15000
}

locals {
  commerce_buyer_routes = {
    checkout_post = "POST /api/checkout"
    fulfill       = "GET /api/fulfill"
    download      = "GET /api/download"
  }
}

resource "aws_apigatewayv2_route" "commerce_buyer" {
  for_each = local.commerce_buyer_routes

  api_id    = aws_apigatewayv2_api.commerce.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.commerce_buyer.id}"
}

resource "aws_apigatewayv2_route" "commerce_webhook" {
  api_id    = aws_apigatewayv2_api.commerce.id
  route_key = "POST /api/stripe-webhook"
  target    = "integrations/${aws_apigatewayv2_integration.commerce_webhook.id}"
}

resource "aws_cloudwatch_log_group" "commerce_api" {
  name              = "/aws/apigateway/${var.name}-commerce"
  retention_in_days = 30
  tags              = local.tags
}

resource "aws_apigatewayv2_stage" "commerce" {
  api_id      = aws_apigatewayv2_api.commerce.id
  name        = "$default"
  auto_deploy = true
  tags        = local.tags

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.commerce_api.arn
    format = jsonencode({
      requestId         = "$context.requestId"
      routeKey          = "$context.routeKey"
      status            = "$context.status"
      integrationStatus = "$context.integration.status"
      latency           = "$context.responseLatency"
      responseSize      = "$context.responseLength"
    })
  }

  route_settings {
    route_key              = "POST /api/checkout"
    throttling_rate_limit  = 2
    throttling_burst_limit = 5
  }

  route_settings {
    route_key              = "GET /api/checkout"
    throttling_rate_limit  = 2
    throttling_burst_limit = 5
  }

  route_settings {
    route_key              = "POST /api/stripe-webhook"
    throttling_rate_limit  = 10
    throttling_burst_limit = 20
  }

  route_settings {
    route_key              = "GET /api/fulfill"
    throttling_rate_limit  = 5
    throttling_burst_limit = 10
  }

  route_settings {
    route_key              = "GET /api/download"
    throttling_rate_limit  = 10
    throttling_burst_limit = 20
  }

  depends_on = [
    aws_apigatewayv2_route.commerce_buyer,
    aws_apigatewayv2_route.commerce_webhook,
  ]
}

resource "aws_lambda_permission" "commerce_buyer_api" {
  for_each = local.commerce_buyer_routes

  statement_id  = "AllowCommerceHttpApi-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.commerce_buyer.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.commerce.execution_arn}/*/${split(" ", each.value)[0]}${split(" ", each.value)[1]}"
}

resource "aws_lambda_permission" "commerce_webhook_api" {
  statement_id  = "AllowCommerceHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.commerce_webhook.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.commerce.execution_arn}/*/POST/api/stripe-webhook"
}

# ---------- Origin-authorized REST API ----------

resource "aws_api_gateway_rest_api" "commerce_rest" {
  name = "${var.name}-commerce-rest"

  # Preserve the exact form and Stripe webhook bytes in the v1 proxy event.
  # The shared HTTP helpers decode either base64 or plain request bodies.
  binary_media_types = [
    "application/json",
    "application/x-www-form-urlencoded",
  ]

  endpoint_configuration {
    types = ["REGIONAL"]
  }

  tags = local.tags
}

# REST API access logging uses the regional API Gateway account singleton.
# The authenticated prework read confirmed that us-east-1 has no existing
# cloudWatchRoleArn, so this stack can configure it without taking over an
# unrelated role. API Gateway validates this account role against the complete
# AmazonAPIGatewayPushToCloudWatchLogs action set on all log resources, even
# when the destination group is precreated. Keep that required wildcard policy
# isolated on this dedicated service role.
resource "aws_iam_role" "commerce_api_gateway_logs" {
  name = "${var.name}-commerce-api-gateway-logs"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "apigateway.amazonaws.com"
      }
    }]
  })
  tags = local.tags
}

data "aws_iam_policy_document" "commerce_api_gateway_logs" {
  statement {
    sid = "ApiGatewayPushToCloudWatchLogs"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:DescribeLogGroups",
      "logs:DescribeLogStreams",
      "logs:FilterLogEvents",
      "logs:GetLogEvents",
      "logs:PutLogEvents",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "commerce_api_gateway_logs" {
  name   = "${var.name}-commerce-api-gateway-logs"
  role   = aws_iam_role.commerce_api_gateway_logs.id
  policy = data.aws_iam_policy_document.commerce_api_gateway_logs.json
}

resource "aws_api_gateway_account" "commerce" {
  cloudwatch_role_arn = aws_iam_role.commerce_api_gateway_logs.arn

  depends_on = [aws_iam_role_policy.commerce_api_gateway_logs]
}

resource "aws_api_gateway_resource" "commerce_rest_api" {
  rest_api_id = aws_api_gateway_rest_api.commerce_rest.id
  parent_id   = aws_api_gateway_rest_api.commerce_rest.root_resource_id
  path_part   = "api"
}

locals {
  commerce_rest_resource_names = toset([
    "checkout",
    "download",
    "fulfill",
    "stripe-webhook",
  ])

  commerce_rest_methods = {
    checkout_post = {
      resource = "checkout"
      method   = "POST"
      target   = "buyer"
      rate     = 2
      burst    = 5
    }
    fulfill_get = {
      resource = "fulfill"
      method   = "GET"
      target   = "buyer"
      rate     = 5
      burst    = 10
    }
    download_get = {
      resource = "download"
      method   = "GET"
      target   = "buyer"
      rate     = 10
      burst    = 20
    }
    webhook_post = {
      resource = "stripe-webhook"
      method   = "POST"
      target   = "webhook"
      rate     = 10
      burst    = 20
    }
  }
}

resource "aws_api_gateway_resource" "commerce_rest" {
  for_each = local.commerce_rest_resource_names

  rest_api_id = aws_api_gateway_rest_api.commerce_rest.id
  parent_id   = aws_api_gateway_resource.commerce_rest_api.id
  path_part   = each.value
}

resource "aws_api_gateway_authorizer" "commerce_origin" {
  name            = "${var.name}-commerce-origin"
  rest_api_id     = aws_api_gateway_rest_api.commerce_rest.id
  authorizer_uri  = aws_lambda_function.commerce_authorizer.invoke_arn
  type            = "TOKEN"
  identity_source = "method.request.header.${var.commerce_origin_verify_header_name}"
  # Short-circuits before the authorizer is invoked; both values stay valid so a
  # rotation in flight is never rejected at the gateway.
  identity_validation_expression   = "^(${join("|", local.commerce_origin_verify_accepted)})$"
  authorizer_result_ttl_in_seconds = 3600
}

resource "aws_lambda_permission" "commerce_authorizer_api" {
  statement_id  = "AllowCommerceRestApiAuthorizer"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.commerce_authorizer.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.commerce_rest.execution_arn}/authorizers/${aws_api_gateway_authorizer.commerce_origin.id}"
}

resource "aws_api_gateway_method" "commerce_rest" {
  for_each = local.commerce_rest_methods

  rest_api_id   = aws_api_gateway_rest_api.commerce_rest.id
  resource_id   = aws_api_gateway_resource.commerce_rest[each.value.resource].id
  http_method   = each.value.method
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.commerce_origin.id
}

resource "aws_api_gateway_integration" "commerce_rest" {
  for_each = local.commerce_rest_methods

  rest_api_id             = aws_api_gateway_rest_api.commerce_rest.id
  resource_id             = aws_api_gateway_resource.commerce_rest[each.value.resource].id
  http_method             = aws_api_gateway_method.commerce_rest[each.key].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri = (
    each.value.target == "buyer"
    ? aws_lambda_function.commerce_buyer.invoke_arn
    : aws_lambda_function.commerce_webhook.invoke_arn
  )
}

resource "aws_api_gateway_gateway_response" "commerce_rest" {
  for_each = toset(["DEFAULT_4XX", "DEFAULT_5XX"])

  rest_api_id   = aws_api_gateway_rest_api.commerce_rest.id
  response_type = each.value
  # API Gateway restores this service-default template when it is omitted.
  # Model it explicitly so refreshes do not produce a perpetual removal plan.
  response_templates = {
    "application/json" = "{\"message\":$context.error.messageString}"
  }
  response_parameters = {
    "gatewayresponse.header.Cache-Control" = "'no-store, private'"
  }
}

resource "aws_api_gateway_deployment" "commerce_rest" {
  rest_api_id = aws_api_gateway_rest_api.commerce_rest.id

  triggers = {
    redeployment = sha1(jsonencode({
      methods = {
        for key, method in aws_api_gateway_method.commerce_rest : key => {
          resource_id   = method.resource_id
          http_method   = method.http_method
          authorization = method.authorization
          authorizer_id = method.authorizer_id
        }
      }
      integrations = {
        for key, integration in aws_api_gateway_integration.commerce_rest : key => {
          resource_id             = integration.resource_id
          http_method             = integration.http_method
          integration_http_method = integration.integration_http_method
          type                    = integration.type
          uri                     = integration.uri
        }
      }
      authorizer = {
        uri                      = aws_api_gateway_authorizer.commerce_origin.authorizer_uri
        type                     = aws_api_gateway_authorizer.commerce_origin.type
        identity_source          = aws_api_gateway_authorizer.commerce_origin.identity_source
        identity_validation_hash = nonsensitive(sha256(aws_api_gateway_authorizer.commerce_origin.identity_validation_expression))
        ttl                      = aws_api_gateway_authorizer.commerce_origin.authorizer_result_ttl_in_seconds
      }
      gateway_responses = {
        for key, response in aws_api_gateway_gateway_response.commerce_rest : key => {
          response_type       = response.response_type
          response_parameters = response.response_parameters
        }
      }
      binary_media_types = aws_api_gateway_rest_api.commerce_rest.binary_media_types
    }))
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [
    aws_api_gateway_integration.commerce_rest,
    aws_api_gateway_gateway_response.commerce_rest,
  ]
}

resource "aws_cloudwatch_log_group" "commerce_rest_api" {
  name              = "/aws/apigateway/${var.name}-commerce-rest"
  retention_in_days = 30
  tags              = local.tags
}

resource "aws_api_gateway_stage" "commerce_rest" {
  rest_api_id   = aws_api_gateway_rest_api.commerce_rest.id
  deployment_id = aws_api_gateway_deployment.commerce_rest.id
  stage_name    = "commerce"
  tags          = local.tags

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.commerce_rest_api.arn
    format = jsonencode({
      requestId         = "$context.requestId"
      route             = "$context.httpMethod $context.resourcePath"
      status            = "$context.status"
      integrationStatus = "$context.integration.status"
      latency           = "$context.responseLatency"
      responseSize      = "$context.responseLength"
    })
  }

  depends_on = [aws_api_gateway_account.commerce]
}

resource "aws_api_gateway_method_settings" "commerce_rest" {
  for_each = local.commerce_rest_methods

  rest_api_id = aws_api_gateway_rest_api.commerce_rest.id
  stage_name  = aws_api_gateway_stage.commerce_rest.stage_name
  method_path = "${trimprefix(aws_api_gateway_resource.commerce_rest[each.value.resource].path, "/")}/${each.value.method}"

  settings {
    throttling_rate_limit  = each.value.rate
    throttling_burst_limit = each.value.burst
  }
}

resource "aws_lambda_permission" "commerce_buyer_rest_api" {
  for_each = {
    for key, route in local.commerce_rest_methods : key => route
    if route.target == "buyer"
  }

  statement_id  = "AllowCommerceRestApi-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.commerce_buyer.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.commerce_rest.execution_arn}/*/${each.value.method}/api/${each.value.resource}"
}

resource "aws_lambda_permission" "commerce_webhook_rest_api" {
  statement_id  = "AllowCommerceRestApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.commerce_webhook.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.commerce_rest.execution_arn}/*/POST/api/stripe-webhook"
}

# ---------- Alarms ----------

resource "aws_sns_topic" "commerce_alarms" {
  name = "${var.name}-commerce-alarms"
  tags = local.tags
}

resource "aws_sns_topic_subscription" "commerce_alarms" {
  topic_arn = aws_sns_topic.commerce_alarms.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

locals {
  # Keep alarms on failures that require distinct operator action. Buyer and
  # Authorizer throttles are intentional reserved-concurrency backpressure; an
  # availability impact is already covered by the API stage 5xx alarms.
  # DynamoDB failures that exhaust SDK retries likewise surface as API 5xx, so
  # per-operation database alarms would duplicate the same incident six times.
  commerce_lambda_alarms = {
    buyer-errors = {
      function_name = aws_lambda_function.commerce_buyer.function_name
      metric_name   = "Errors"
    }
    webhook-errors = {
      function_name = aws_lambda_function.commerce_webhook.function_name
      metric_name   = "Errors"
    }
    webhook-throttles = {
      function_name = aws_lambda_function.commerce_webhook.function_name
      metric_name   = "Throttles"
    }
    authorizer-errors = {
      function_name = aws_lambda_function.commerce_authorizer.function_name
      metric_name   = "Errors"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "commerce_api_5xx" {
  alarm_name        = "${var.name}-commerce-api-5xx"
  alarm_description = "The commerce HTTP API returned a server error."
  namespace         = "AWS/ApiGateway"
  metric_name       = "5xx"
  dimensions = {
    ApiId = aws_apigatewayv2_api.commerce.id
    Stage = aws_apigatewayv2_stage.commerce.name
  }

  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.commerce_alarms.arn]
  ok_actions          = [aws_sns_topic.commerce_alarms.arn]
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "commerce_rest_api_5xx" {
  alarm_name        = "${var.name}-commerce-rest-api-5xx"
  alarm_description = "The origin-authorized commerce REST API returned a server error."
  namespace         = "AWS/ApiGateway"
  metric_name       = "5XXError"
  dimensions = {
    ApiName = aws_api_gateway_rest_api.commerce_rest.name
    Stage   = aws_api_gateway_stage.commerce_rest.stage_name
  }

  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.commerce_alarms.arn]
  ok_actions          = [aws_sns_topic.commerce_alarms.arn]
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "commerce_lambda" {
  for_each = local.commerce_lambda_alarms

  alarm_name        = "${var.name}-commerce-${each.key}"
  alarm_description = "The ${each.value.function_name} Lambda reported ${lower(each.value.metric_name)}."
  namespace         = "AWS/Lambda"
  metric_name       = each.value.metric_name
  dimensions        = { FunctionName = each.value.function_name }

  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.commerce_alarms.arn]
  ok_actions          = [aws_sns_topic.commerce_alarms.arn]
  tags                = local.tags
}

# ---------- Outputs ----------

output "commerce_secret_param" {
  value = aws_ssm_parameter.commerce.name
}

output "commerce_webhook_secret_param" {
  value = aws_ssm_parameter.commerce_webhook.name
}

output "commerce_test_secret_param" {
  description = "Test-mode keys read by local commerce tooling"
  value       = aws_ssm_parameter.commerce_test.name
}

output "commerce_orders_table" {
  value = aws_dynamodb_table.commerce_orders.name
}

output "commerce_api_endpoint" {
  value = aws_apigatewayv2_api.commerce.api_endpoint
}

output "commerce_rest_api_endpoint" {
  value = "https://${aws_api_gateway_rest_api.commerce_rest.id}.execute-api.us-east-1.amazonaws.com/${aws_api_gateway_stage.commerce_rest.stage_name}"
}
