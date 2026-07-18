output "cloudfront_url" {
  value = "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "site_bucket" {
  value = aws_s3_bucket.site.bucket
}

output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}

output "nameservers" {
  description = "Point the registrar at these once enable_custom_domain = true"
  value       = var.enable_custom_domain ? aws_route53_zone.site[0].name_servers : null
}
