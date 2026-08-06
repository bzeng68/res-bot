# These create the secret containers only. Populate the actual values out of
# band (e.g. `gcloud secrets versions add encryption-key --data-file=-`) so
# secret material never lands in a .tfvars file or the Terraform state diff.

resource "google_secret_manager_secret" "encryption_key" {
  secret_id = "${var.app_name}-encryption-key"

  replication {
    auto {}
  }

  depends_on = [google_project_service.this]
}

resource "google_secret_manager_secret" "smtp_credentials" {
  secret_id = "${var.app_name}-smtp-credentials"

  replication {
    auto {}
  }

  depends_on = [google_project_service.this]
}

# Shared secret the worker attaches (X-Internal-Token header) when it POSTs
# booking status back to the control plane's /internal/reservation-status —
# that route sits on the control plane's otherwise-public service, so it
# can't rely on Cloud Run IAM the way the worker's own invocation does.
resource "google_secret_manager_secret" "internal_callback_token" {
  secret_id = "${var.app_name}-internal-callback-token"

  replication {
    auto {}
  }

  depends_on = [google_project_service.this]
}
