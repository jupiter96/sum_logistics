// docker-bake.hcl
variable "REGISTRY" { default = "" }
variable "VERSION" { default = "latest" }
variable "CACHE" { default = "" }
variable "GCP" { default = false }
variable "GITHUB_AUTH_KEY" { default = "" }

group "default" {
  targets = ["app", "app-httpd"]
}

group "release" {
  targets = ["sum_logistics-console", "sum_logistics-api", "sum_logistics-socket"]
}

target "app" {
  name = "app-${tgt}"

  // use matrix strategy to build several targets at once
  matrix = {
    tgt = ["app", "scheduler", "events"]
  }
  context = "./"
  // set the target from matrix
  target     = tgt
  dockerfile = "docker/Dockerfile"
  platforms  = ["linux/amd64"]

  # Generate tags for both the canonical name (${tgt})
  # and an alias (api) *only when tgt == "app"*
  tags = notequal("", REGISTRY) ? concat(
    # normal tags for tgt (app/scheduler/events)
    formatlist(
      GCP ? "${REGISTRY}/${tgt}:%s" : "${REGISTRY}:${tgt}-%s",
      compact(["latest", VERSION])
    ),
    # alias tags for api (only if this is the "app" variant)
    tgt == "app" ? formatlist(
      GCP ? "${REGISTRY}/api:%s" : "${REGISTRY}:api-%s",
      compact(["latest", VERSION])
    ) : []
  ) : []

  args = {
    GITHUB_AUTH_KEY = "${GITHUB_AUTH_KEY}"
  }

  cache-from = notequal("", CACHE) ? ["${CACHE}"] : []
  cache-to   = notequal("", CACHE) ? ["${CACHE},mode=max,ignore-error=true"] : []
}

target "app-httpd" {
  context    = "./"
  dockerfile = "docker/nginx/Dockerfile"
  platforms  = ["linux/amd64"]

  tags = notequal("", REGISTRY) ? formatlist(
    GCP ? "${REGISTRY}/app-httpd:%s" : "${REGISTRY}:app-httpd-%s",
    compact(["latest", VERSION])
  ) : []
}

target "sum_logistics-console" {
  context    = "./frontend"
  dockerfile = "Dockerfile"
  platforms  = ["linux/amd64"]

  tags = notequal("", REGISTRY) ? formatlist(
    "${REGISTRY}/sum_logistics-console:%s",
    compact(["latest", VERSION])
  ) : []
}

target "sum_logistics-api" {
  context    = "./"
  dockerfile = "docker/Dockerfile"
  target     = "app-release"
  platforms  = ["linux/amd64", "linux/arm64"]

  tags = notequal("", REGISTRY) ? formatlist(
    "${REGISTRY}/sum_logistics-api:%s",
    compact(["latest", VERSION])
  ) : []
}

target "sum_logistics-socket" {
  context    = "./websocket-server"
  dockerfile = "Dockerfile"
  platforms  = ["linux/amd64", "linux/arm64"]

  tags = notequal("", REGISTRY) ? formatlist(
    "${REGISTRY}/sum_logistics-socket:%s",
    compact(["latest", VERSION])
  ) : []
}
