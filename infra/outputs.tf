output "control_plane_url" {
  description = "Public URL for the web UI / API / WebSocket dashboard"
  value       = google_cloud_run_v2_service.control_plane.uri
}

output "worker_url" {
  description = "URL for the worker service (not publicly invokable — IAM-gated to the control plane's service account)"
  value       = google_cloud_run_v2_service.worker.uri
}

output "control_plane_service_account_email" {
  value = google_service_account.control_plane.email
}

output "worker_service_account_email" {
  value = google_service_account.worker.email
}

output "tasks_queue_id" {
  description = "Full resource ID of the Cloud Tasks queue booking triggers are enqueued into"
  value       = google_cloud_tasks_queue.booking_jobs.id
}

output "artifact_registry_repository" {
  description = "Push control-plane/worker images here, e.g. {region}-docker.pkg.dev/{project}/{repo}/control-plane:tag"
  value       = google_artifact_registry_repository.res_bot.name
}

output "encryption_key_secret_id" {
  value = google_secret_manager_secret.encryption_key.secret_id
}

output "smtp_credentials_secret_id" {
  value = google_secret_manager_secret.smtp_credentials.secret_id
}

output "internal_callback_token_secret_id" {
  value = google_secret_manager_secret.internal_callback_token.secret_id
}
