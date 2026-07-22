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
  description = "Route 53 nameservers to set at the registrar"
  value       = aws_route53_zone.site.name_servers
}
