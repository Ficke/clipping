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

# GitHub now embeds immutable account/repo IDs in the OIDC sub claim
# (e.g. repo:Owner@<owner_id>/repo@<repo_id>:ref:...). Find them via:
#   gh api repos/<owner>/<repo> --jq '{owner_id: .owner.id, repo_id: .id}'
variable "github_repository_id_qualified" {
  description = "Owner@id/repo@id form of github_repository, as issued in OIDC sub claims"
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
