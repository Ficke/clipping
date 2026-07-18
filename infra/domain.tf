# Custom-domain resources, created only when enable_custom_domain = true.
# Prereq: the domain's registrar must delegate to this zone's nameservers
# (or the ACM DNS validation below will never complete). See README.

resource "aws_route53_zone" "site" {
  count = var.enable_custom_domain ? 1 : 0
  name  = var.domain_name
  tags  = local.tags
}

resource "aws_acm_certificate" "site" {
  count                     = var.enable_custom_domain ? 1 : 0
  domain_name               = var.domain_name
  subject_alternative_names = ["www.${var.domain_name}"]
  validation_method         = "DNS"
  tags                      = local.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = var.enable_custom_domain ? {
    for dvo in aws_acm_certificate.site[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  zone_id = aws_route53_zone.site[0].zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 300
}

resource "aws_acm_certificate_validation" "site" {
  count                   = var.enable_custom_domain ? 1 : 0
  certificate_arn         = aws_acm_certificate.site[0].arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

resource "aws_route53_record" "site" {
  for_each = var.enable_custom_domain ? toset(["A", "AAAA"]) : toset([])

  zone_id = aws_route53_zone.site[0].zone_id
  name    = var.domain_name
  type    = each.value

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "www" {
  for_each = var.enable_custom_domain ? toset(["A", "AAAA"]) : toset([])

  zone_id = aws_route53_zone.site[0].zone_id
  name    = "www.${var.domain_name}"
  type    = each.value

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}
