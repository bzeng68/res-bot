resource "google_artifact_registry_repository" "res_bot" {
  repository_id = var.app_name
  location      = var.region
  format        = "DOCKER"
  description   = "Container images for res-bot control-plane and worker services"

  depends_on = [google_project_service.this]
}
