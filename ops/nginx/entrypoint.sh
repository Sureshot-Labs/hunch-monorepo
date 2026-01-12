#!/bin/sh
set -e

SERVER_NAME="${NGINX_SERVER_NAME:-_}"
READ_TIMEOUT="${NGINX_PROXY_READ_TIMEOUT:-3600}"
SEND_TIMEOUT="${NGINX_PROXY_SEND_TIMEOUT:-3600}"
SSL_CERT="${NGINX_SSL_CERT:-}"
SSL_KEY="${NGINX_SSL_KEY:-}"

sed \
  -e "s/__SERVER_NAME__/${SERVER_NAME}/g" \
  -e "s/__PROXY_READ_TIMEOUT__/${READ_TIMEOUT}/g" \
  -e "s/__PROXY_SEND_TIMEOUT__/${SEND_TIMEOUT}/g" \
  -e "s#__SSL_CERT__#${SSL_CERT}#g" \
  -e "s#__SSL_KEY__#${SSL_KEY}#g" \
  /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf

exec nginx -g "daemon off;"
