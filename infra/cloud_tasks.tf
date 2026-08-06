# Queue for one-time, precisely-timed booking triggers. The control plane
# enqueues a task per reservation with `schedule_time` set to
# (booking-window-open − 15min); Cloud Tasks delivers it as an authenticated
# HTTP call to the worker service at that exact time.
resource "google_cloud_tasks_queue" "booking_jobs" {
  name     = "${var.app_name}-booking-jobs"
  location = var.region

  rate_limits {
    max_concurrent_dispatches = 10
    max_dispatches_per_second = 5
  }

  retry_config {
    max_attempts  = 3
    min_backoff   = "10s"
    max_backoff   = "60s"
    max_doublings = 2
  }

  depends_on = [google_project_service.this]
}
