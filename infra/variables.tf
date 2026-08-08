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

# Keep true after the domain's nameservers point at the Route 53 hosted zone.
# Set false only while preparing a new zone before its registrar cutover.
variable "enable_custom_domain" {
  description = "Create the ACM certificate and attach the domain to CloudFront"
  type        = bool
  default     = true
}

variable "commerce_origin_verify_header_name" {
  description = "Header CloudFront injects so commerce handlers can detect direct execute-api requests"
  type        = string
  default     = "X-Commerce-Origin-Verify"

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+$", var.commerce_origin_verify_header_name))
    error_message = "The origin-verification header name may contain only letters, digits, and hyphens."
  }
}

variable "commerce_origin_verify_active" {
  description = "Which generated origin-verification secret CloudFront sends. Both are always accepted, so flipping this rotates without a propagation window"
  type        = string
  default     = "current"

  validation {
    condition     = contains(["current", "next"], var.commerce_origin_verify_active)
    error_message = "The active origin-verification secret must be either current or next."
  }
}

variable "commerce_allow_legacy_get_checkout" {
  description = "Accept the superseded GET /api/checkout. The POST storefront has propagated and the old HTML has expired, so this stays off; a state-changing GET is prefetchable and cross-site triggerable"
  type        = bool
  default     = false
}

variable "commerce_rest_cutover_enabled" {
  description = "Route CloudFront commerce traffic to the origin-authorized REST API after its additive verification gate"
  type        = bool
  default     = true
}

variable "commerce_reserved_concurrency_enabled" {
  description = "Reserve Buyer/Webhook/Authorizer concurrency after the regional Lambda quota increase is granted"
  type        = bool
  default     = true
}

variable "commerce_http_api_dormant" {
  description = "Disable the superseded HTTP API default endpoint after the REST cutover has fully propagated"
  type        = bool
  default     = true
}
