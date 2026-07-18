variable "name" {
  description = "Project name used to tag and name resources"
  type        = string
  default     = "adamficke-com"
}

variable "bucket_name" {
  description = "Globally-unique S3 bucket for the built site"
  type        = string
  default     = "adamficke-com-site"
}

variable "github_repository" {
  description = "GitHub org/repo allowed to deploy via OIDC"
  type        = string
  default     = "Ficke/clipping"
}

variable "domain_name" {
  description = "Apex domain for the site"
  type        = string
  default     = "adamficke.com"
}

# Flip to true once the Route 53 hosted zone can become authoritative
# (i.e. when the domain's nameservers point at it). See README: Domain cutover.
variable "enable_custom_domain" {
  description = "Create Route 53 zone + ACM cert and attach the domain to CloudFront"
  type        = bool
  default     = false
}
