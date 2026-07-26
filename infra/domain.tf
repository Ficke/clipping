# CloudFront answers for the canonical apex plus every redirect domain, each
# with its www. sibling. The rewrite function 301s everything to domain_name.

locals {
  served_apexes = var.enable_custom_domain ? concat([var.domain_name], var.redirect_domains) : []

  # hostname => apex whose hosted zone holds its records
  served_hosts = {
    for host in flatten([for apex in local.served_apexes : [apex, "www.${apex}"]]) :
    host => replace(host, "/^www\\./", "")
  }
}

moved {
  from = aws_route53_zone.site
  to   = aws_route53_zone.site["adamficke.com"]
}

moved {
  from = aws_route53_record.site["A"]
  to   = aws_route53_record.site["adamficke.dev|A"]
}

moved {
  from = aws_route53_record.site["AAAA"]
  to   = aws_route53_record.site["adamficke.dev|AAAA"]
}

moved {
  from = aws_route53_record.www["A"]
  to   = aws_route53_record.site["www.adamficke.dev|A"]
}

moved {
  from = aws_route53_record.www["AAAA"]
  to   = aws_route53_record.site["www.adamficke.dev|AAAA"]
}

resource "aws_route53_zone" "site" {
  for_each = var.managed_domains
  name     = each.value
  tags     = local.tags
}

resource "aws_acm_certificate" "site" {
  count       = var.enable_custom_domain ? 1 : 0
  domain_name = var.domain_name
  subject_alternative_names = [
    for host in keys(local.served_hosts) : host if host != var.domain_name
  ]
  validation_method = "DNS"
  tags              = local.tags

  lifecycle {
    create_before_destroy = true
  }
}

# allow_overwrite lets the new certificate reuse the validation record names
# the retired adamficke.dev certificate left behind.
resource "aws_route53_record" "cert_validation" {
  for_each = var.enable_custom_domain ? {
    for dvo in aws_acm_certificate.site[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
      zone   = local.served_hosts[dvo.domain_name]
    }
  } : {}

  zone_id         = aws_route53_zone.site[each.value.zone].zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "site" {
  count                   = var.enable_custom_domain ? 1 : 0
  certificate_arn         = aws_acm_certificate.site[0].arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

resource "aws_route53_record" "site" {
  for_each = {
    for pair in setproduct(keys(local.served_hosts), ["A", "AAAA"]) :
    "${pair[0]}|${pair[1]}" => { host = pair[0], type = pair[1] }
  }

  zone_id = aws_route53_zone.site[local.served_hosts[each.value.host]].zone_id
  name    = each.value.host
  type    = each.value.type

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}
