output "cloudfront_url" {
  value = "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "site_bucket" {
  value = aws_s3_bucket.site.bucket
}

output "access_logs_bucket" {
  value = aws_s3_bucket.access_logs.bucket
}

output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}

output "nameservers" {
  description = "Route 53 nameservers per managed zone, to set at each registrar"
  value       = { for domain, zone in aws_route53_zone.site : domain => zone.name_servers }
}
