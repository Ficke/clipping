locals {
  tags = {
    Project   = var.name
    ManagedBy = "terraform"
  }

  # Shared by both response-headers policies below, which differ only in
  # referrer policy. One string, so the two cannot drift apart.
  content_security_policy = join("; ", [
    "default-src 'none'",
    "script-src 'self' https://*.googletagmanager.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https://*.google-analytics.com https://*.googletagmanager.com",
    "font-src 'self'",
    "connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    # The storefront posts to Stripe Checkout; 'none' would block the buy form.
    "form-action 'self' https://checkout.stripe.com",
  ])

  permissions_policy = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()"
}

# ---------- S3 (private; CloudFront-only access) ----------

resource "aws_s3_bucket" "site" {
  bucket = var.bucket_name
  tags   = local.tags
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "site_bucket" {
  statement {
    sid       = "CloudFrontRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }

  # ListBucket lets S3 answer 404 (not 403) for missing keys, so CloudFront's
  # 404 -> /404.html mapping stays truthful.
  statement {
    sid       = "CloudFrontList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.site.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.site.arn, "${aws_s3_bucket.site.arn}/*"]

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

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = data.aws_iam_policy_document.site_bucket.json
}

# ---------- CloudFront ----------

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = var.name
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Rewrites pretty URLs to the S3 object Astro actually emits
# (/about/ -> /about/index.html) and 301s every other served host
# (www., the old .dev domain, the cloudfront.net name) to the canonical apex.
resource "aws_cloudfront_function" "rewrite" {
  name    = "${var.name}-rewrite"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-EOT
    function handler(event) {
      var request = event.request;
      var host = request.headers.host ? request.headers.host.value : '';

      // Commerce reads this object directly from private S3 with IAM. It must
      // never be served through the public site distribution.
      if (request.uri === '/downloads-catalog.json') {
        return {
          statusCode: 404,
          statusDescription: 'Not Found',
          headers: { 'cache-control': { value: 'no-store' } }
        };
      }

      // Album URLs from the old Squarespace site
      var legacy = {
        '/photography/salt-point-state-park': '/photography/salt-point/',
        '/photography/grand-canyon-of-the-tuolumne': '/photography/tuolumne/',
        '/photography/yosemite-april-25': '/photography/yosemite/',
        '/photography/desolation-wilderness-july-4th-24': '/photography/desolation-wilderness/',
        '/photography/great-highway-amp-dolores-june-24': '/photography/great-highway-dolores/',
        '/photography/yj638n83sg6fcdguko5uqv6ih70ngf': '/photography/crissy-field/'
      };
      var path = request.uri.endsWith('/') ? request.uri.slice(0, -1) : request.uri;
      if (legacy[path]) {
        return {
          statusCode: 301,
          statusDescription: 'Moved Permanently',
          headers: { location: { value: legacy[path] } }
        };
      }

      var canonical = '${var.domain_name}';
      if (host && host !== canonical) {
        return {
          statusCode: 301,
          statusDescription: 'Moved Permanently',
          headers: {
            location: { value: 'https://' + canonical + request.uri }
          }
        };
      }

      if (request.uri.endsWith('/')) {
        request.uri += 'index.html';
      } else if (!request.uri.includes('.')) {
        request.uri += '/index.html';
      }
      return request;
    }
  EOT
}

resource "aws_cloudfront_response_headers_policy" "security" {
  name = "${var.name}-security-headers"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    content_security_policy {
      content_security_policy = local.content_security_policy
      override                = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = local.permissions_policy
      override = true
    }
  }
}

# Purchase responses carry the same controls as the rest of the static site,
# but suppress the Checkout Session bearer capability from outgoing referrers.
resource "aws_cloudfront_response_headers_policy" "purchase_security" {
  name = "${var.name}-purchase-security-headers"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }

    content_security_policy {
      content_security_policy = local.content_security_policy
      override                = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = local.permissions_policy
      override = true
    }
  }
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  comment             = var.name
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  aliases             = keys(local.served_hosts)
  tags                = local.tags

  origin {
    origin_id                = "s3"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  origin {
    origin_id                = "media"
    domain_name              = aws_s3_bucket.media.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  # First apply the REST API additively with this origin still targeting the
  # deployed HTTP API. After direct ingress verification, a separate exact-plan
  # gate flips this origin to REST. Both APIs remain managed as rollback rails.
  origin {
    origin_id   = "commerce"
    domain_name = var.commerce_rest_cutover_enabled ? "${aws_api_gateway_rest_api.commerce_rest.id}.execute-api.us-east-1.amazonaws.com" : replace(aws_apigatewayv2_api.commerce.api_endpoint, "https://", "")
    origin_path = var.commerce_rest_cutover_enabled ? "/${aws_api_gateway_stage.commerce_rest.stage_name}" : null

    custom_origin_config {
      origin_protocol_policy = "https-only"
      http_port              = 80
      https_port             = 443
      origin_ssl_protocols   = ["TLSv1.2"]
    }

    # One header, checked by both the gateway authorizer and the handlers.
    # A second derived from the first would have added a rotation coupling
    # without adding isolation: whoever learns this value can compute it.
    custom_header {
      name  = var.commerce_origin_verify_header_name
      value = local.commerce_origin_verify_active
    }
  }

  # Checkout, webhook, fulfillment, and download responses. No caching, all
  # viewer methods and headers forwarded, and no viewer-request function: the
  # pretty-URL rewrite would turn /api/checkout into /api/checkout/index.html.
  ordered_cache_behavior {
    path_pattern             = "api/*"
    target_origin_id         = "commerce"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # managed CachingDisabled
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # managed AllViewerExceptHostHeader

    # Deliberately no response_headers_policy: the site's CSP and frame rules
    # describe HTML, and attaching them here would put a CSP on JSON and on
    # 302s to S3 that no browser needs to evaluate.
  }

  ordered_cache_behavior {
    path_pattern               = "purchase/*"
    target_origin_id           = "s3"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = "658327ea-f89d-4fab-a63d-7e88639e58f6" # managed CachingOptimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.purchase_security.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.rewrite.arn
    }
  }

  ordered_cache_behavior {
    path_pattern               = "media/*"
    target_origin_id           = "media"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = "658327ea-f89d-4fab-a63d-7e88639e58f6" # managed CachingOptimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  default_cache_behavior {
    target_origin_id           = "s3"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = "658327ea-f89d-4fab-a63d-7e88639e58f6" # managed CachingOptimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.rewrite.arn
    }
  }

  custom_error_response {
    error_code            = 404
    response_code         = 404
    response_page_path    = "/404.html"
    error_caching_min_ttl = 60
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.enable_custom_domain ? null : true
    acm_certificate_arn            = var.enable_custom_domain ? aws_acm_certificate_validation.site[0].certificate_arn : null
    ssl_support_method             = var.enable_custom_domain ? "sni-only" : null
    minimum_protocol_version       = var.enable_custom_domain ? "TLSv1.2_2021" : "TLSv1"
  }
}
