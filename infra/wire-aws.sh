#!/usr/bin/env bash
# One-shot bootstrap: run after `aws login` (any admin-ish credentials).
# Applies the infra, wires GitHub Actions to it, deploys, and smoke-tests.
set -euo pipefail
cd "$(dirname "$0")"

REPO="Ficke/clipping"

echo "==> Checking credentials"
aws sts get-caller-identity --query Account --output text ||
  { echo "AWS credentials missing — run: aws login"; exit 1; }
gh auth status -h github.com >/dev/null || { echo "gh not logged in"; exit 1; }

echo "==> Terraform apply"
terraform init -input=false
# If this fails with EntityAlreadyExists on the OIDC provider (one may already
# exist in the account), import it and re-run:
#   terraform import aws_iam_openid_connect_provider.github \
#     arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com
terraform apply

ROLE=$(terraform output -raw deploy_role_arn)
BUCKET=$(terraform output -raw site_bucket)
DIST=$(terraform output -raw cloudfront_distribution_id)
URL=$(terraform output -raw cloudfront_url)

echo "==> Setting GitHub Actions variables"
gh variable set AWS_DEPLOY_ROLE_ARN --body "$ROLE" -R "$REPO"
gh variable set SITE_BUCKET --body "$BUCKET" -R "$REPO"
gh variable set CLOUDFRONT_DISTRIBUTION_ID --body "$DIST" -R "$REPO"

echo "==> Deploying"
gh workflow run deploy.yml -R "$REPO"
sleep 5
RUN=$(gh run list -R "$REPO" --workflow=Deploy --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN" -R "$REPO" --exit-status

echo "==> Smoke test"
for path in / /photography/salt-point/ /about/ /photography/salt-point-state-park; do
  printf '%-45s' "$URL$path"
  curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "$URL$path"
done

echo
echo "Live at: $URL"
