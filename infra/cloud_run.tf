locals {
  # Cloud Run requires a valid image at create time. These placeholders let
  # `terraform apply` succeed before the first real image is pushed; the
  # lifecycle block below stops later `apply`s from reverting whatever
  # image your CI/CD pipeline deploys.
  control_plane_image = var.control_plane_image != "" ? var.control_plane_image : "us-docker.pkg.dev/cloudrun/container/hello"
  worker_image        = var.worker_image != "" ? var.worker_image : "us-docker.pkg.dev/cloudrun/container/hello"
}

resource "google_cloud_run_v2_service" "worker" {
  name     = "${var.app_name}-worker"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL" # reachable at a public URL, but locked down by IAM below (no allUsers invoker)
  # Stateless ephemeral compute — all real state lives in Firestore, so
  # letting Terraform freely replace this service (e.g. on required-replace
  # field changes) is safe, unlike a database.
  deletion_protection = false

  template {
    service_account = google_service_account.worker.email
    # The worker is invoked ~15min before the booking window opens and waits
    # out that lead time in-process (prewarm/fallback timers) before firing.
    # Cloud Run's default 300s request timeout would kill it long before
    # then, so extend it well past the 15min lead + retry margin.
    timeout = "1200s"

    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }

    containers {
      image = local.worker_image

      ports {
        container_port = 8080
      }

      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      # No CONTROL_PLANE_CALLBACK_URL here: baking it in would create a
      # Terraform dependency cycle (control-plane also needs worker.uri).
      # The control plane derives its own base URL from the inbound request
      # host at runtime and includes it in each task's payload instead.
      env {
        name = "ENCRYPTION_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.encryption_key.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "SMTP_CREDENTIALS"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.smtp_credentials.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "INTERNAL_CALLBACK_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.internal_callback_token.secret_id
            version = "latest"
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].containers[0].image]
  }

  depends_on = [google_project_service.this]
}

# Only the control plane's identity may invoke the worker — Cloud Tasks
# attaches an OIDC token for this service account when it dispatches.
resource "google_cloud_run_v2_service_iam_member" "worker_invoker" {
  name     = google_cloud_run_v2_service.worker.name
  location = google_cloud_run_v2_service.worker.location
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.control_plane.email}"
}

resource "google_cloud_run_v2_service" "control_plane" {
  name                = "${var.app_name}-control-plane"
  location            = var.region
  deletion_protection = false
  ingress             = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.control_plane.email

    scaling {
      min_instance_count = var.control_plane_min_instances
      max_instance_count = 2
    }

    containers {
      image = local.control_plane_image

      ports {
        container_port = 3001
      }

      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "GCP_REGION"
        value = var.region
      }
      env {
        name  = "WORKER_URL"
        value = google_cloud_run_v2_service.worker.uri
      }
      env {
        # Identity attached to each Cloud Task's OIDC token — must match
        # whichever service account is granted run.invoker on the worker
        # (see worker_invoker below), which is this same service's own SA.
        name  = "CONTROL_PLANE_SERVICE_ACCOUNT_EMAIL"
        value = google_service_account.control_plane.email
      }
      env {
        name  = "TASKS_QUEUE_ID"
        value = google_cloud_tasks_queue.booking_jobs.name
      }
      env {
        name = "ENCRYPTION_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.encryption_key.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "INTERNAL_CALLBACK_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.internal_callback_token.secret_id
            version = "latest"
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].containers[0].image]
  }

  depends_on = [google_project_service.this]
}

# Public — this is the web UI/API/WS endpoint.
resource "google_cloud_run_v2_service_iam_member" "control_plane_public" {
  name     = google_cloud_run_v2_service.control_plane.name
  location = google_cloud_run_v2_service.control_plane.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}
