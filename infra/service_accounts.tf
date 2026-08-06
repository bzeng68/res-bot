resource "google_service_account" "control_plane" {
  account_id   = "${var.app_name}-control-plane"
  display_name = "res-bot control plane (UI/API/WS, enqueues booking tasks)"
}

resource "google_service_account" "worker" {
  account_id   = "${var.app_name}-worker"
  display_name = "res-bot worker (runs poll/retry/book, then exits)"
}

# --- Control plane permissions ---

resource "google_project_iam_member" "control_plane_tasks_enqueuer" {
  project = var.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

resource "google_project_iam_member" "control_plane_datastore_user" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

resource "google_project_iam_member" "control_plane_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

# --- Worker permissions ---

resource "google_project_iam_member" "worker_datastore_user" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_project_iam_member" "worker_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.worker.email}"
}
