terraform {
  required_version = ">= 1.7.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # Local state by default. Once you've created a state bucket, uncomment
  # and point this at it (`terraform init -migrate-state`):
  #
  # backend "gcs" {
  #   bucket = "res-bot-tfstate"
  #   prefix = "infra"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
