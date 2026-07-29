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

# GitHub embeds immutable account/repo IDs in the OIDC sub claim for repos
# created after 2026-07-15 (repo:Owner@<owner_id>/repo@<repo_id>:ref:...),
# so trust survives account/repo name recycling. Find the IDs via:
#   gh api repos/<owner>/<repo> --jq '{owner_id: .owner.id, repo_id: .id}'
variable "github_repository" {
  description = "Owner@id/repo@id allowed to deploy via OIDC, as issued in sub claims"
  type        = string
  default     = "Ficke@6045217/clipping@1304655366"
}

variable "domain_name" {
  description = "Canonical apex domain; every other served name 301s here"
  type        = string
  default     = "adamficke.com"
}

variable "redirect_domains" {
  description = "Apex domains CloudFront also answers for, redirected to domain_name"
  type        = list(string)
  default     = ["adamficke.dev"]
}

variable "managed_domains" {
  description = "Domains with Route 53 hosted zones retained by this stack"
  type        = set(string)
  default     = ["adamficke.com", "adamficke.dev"]
}

# A verified SES identity in this account. Leave empty to launch without
# delivery emails: buyers still get their file from the page they land on after
# paying, and the Lambda logs that it sent nothing. Setting it also grants the
# Lambda ses:SendEmail, pinned to this exact address.
variable "commerce_from_email" {
  description = "Verified SES sender for download delivery emails; empty disables them"
  type        = string
  default     = ""
}

# Keep true after the domain's nameservers point at the Route 53 hosted zone.
# Set false only while preparing a new zone before its registrar cutover.
variable "enable_custom_domain" {
  description = "Create the ACM certificate and attach the domain to CloudFront"
  type        = bool
  default     = true
}
