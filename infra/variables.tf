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
