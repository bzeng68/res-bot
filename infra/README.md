# infra

Terraform for res-bot's GCP deployment: two Cloud Run services (control plane
+ worker), a Cloud Tasks queue for one-time booking triggers, Firestore,
Artifact Registry, and the service accounts/IAM tying them together.

## Resources created

- Artifact Registry repo for container images
- Firestore (Native mode) — replaces the local encrypted JSON file store
- Cloud Tasks queue — the control plane enqueues one task per reservation,
  `schedule_time` set to (booking window opens − 15min); Cloud Tasks delivers
  it as an OIDC-authenticated call to the worker at that exact time
- Cloud Run: `control-plane` (public, serves UI/API/WS) and `worker`
  (private — only the control plane's service account can invoke it)
- Secret Manager containers for the encryption key and SMTP credentials
  (values are NOT set by Terraform — see below)

## First-time setup

```bash
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars: set project_id

terraform init
terraform apply   # creates infra with placeholder Cloud Run images
```

Then push real images and populate secrets out of band, so secret values
never end up in a `.tfvars` file or the Terraform state diff:

```bash
gcloud secrets versions add res-bot-encryption-key --data-file=- <<< "$ENCRYPTION_KEY"
gcloud secrets versions add res-bot-smtp-credentials --data-file=path/to/smtp-creds.json

# build & push, then either re-run `terraform apply -var control_plane_image=... -var worker_image=...`
# once, or just `gcloud run deploy` directly from CI/CD after that —
# the `lifecycle.ignore_changes` on each service's image means Terraform
# won't fight your deploy pipeline over the image tag.
```

## State

Local state by default. Before this leaves your laptop, create a GCS bucket
for remote state and uncomment the `backend "gcs"` block in `versions.tf`.
