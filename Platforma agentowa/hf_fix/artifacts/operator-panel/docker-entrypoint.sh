#!/bin/sh
# Render nginx.conf from template at container start, substituting env vars.
# Runs as part of the nginx:alpine /docker-entrypoint.d/* chain before nginx
# itself starts. See https://hub.docker.com/_/nginx ("Using environment
# variables in nginx configuration").

set -e

: "${API_SERVER_URL:=http://api-server:8080}"
export API_SERVER_URL

envsubst '${API_SERVER_URL}' \
  < /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf

echo "✅ nginx.conf rendered with API_SERVER_URL=${API_SERVER_URL}"
