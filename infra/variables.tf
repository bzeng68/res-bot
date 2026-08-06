variable "project_id" {
  description = "GCP project ID to deploy into"
  type        = string
}

variable "region" {
  description = "GCP region for Cloud Run, Cloud Tasks, Artifact Registry"
  type        = string
  default     = "us-central1"
}

variable "firestore_location" {
  description = "Firestore location (may differ from region — see GCP's Firestore location list)"
  type        = string
  default     = "nam5"
}

variable "app_name" {
  description = "Prefix used for naming resources"
  type        = string
  default     = "res-bot"
}

variable "control_plane_image" {
  description = "Container image for the control-plane service (UI/API/WS + task enqueueing). Defaults to a placeholder in the Artifact Registry repo this stack creates."
  type        = string
  default     = ""
}

variable "worker_image" {
  description = "Container image for the ephemeral worker service (poll/retry/book logic). Defaults to a placeholder in the Artifact Registry repo this stack creates."
  type        = string
  default     = ""
}

variable "control_plane_min_instances" {
  description = "Min instances for the control plane. 0 = scale to zero (cheapest, cold start on UI visits); 1 = always warm."
  type        = number
  default     = 0
}
