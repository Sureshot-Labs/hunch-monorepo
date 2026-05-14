#!/bin/sh
set -e

SERVER_NAME="${NGINX_SERVER_NAME:-_}"
APP_SERVER_NAME="${NGINX_APP_SERVER_NAME:-_}"
READ_TIMEOUT="${NGINX_PROXY_READ_TIMEOUT:-3600}"
SEND_TIMEOUT="${NGINX_PROXY_SEND_TIMEOUT:-3600}"
SSL_CERT="${NGINX_SSL_CERT:-}"
SSL_KEY="${NGINX_SSL_KEY:-}"
APP_SSL_CERT="${NGINX_APP_SSL_CERT:-}"
APP_SSL_KEY="${NGINX_APP_SSL_KEY:-}"

sed \
  -e "s/__SERVER_NAME__/${SERVER_NAME}/g" \
  -e "s/__APP_SERVER_NAME__/${APP_SERVER_NAME}/g" \
  -e "s/__PROXY_READ_TIMEOUT__/${READ_TIMEOUT}/g" \
  -e "s/__PROXY_SEND_TIMEOUT__/${SEND_TIMEOUT}/g" \
  -e "s#__SSL_CERT__#${SSL_CERT}#g" \
  -e "s#__SSL_KEY__#${SSL_KEY}#g" \
  -e "s#__APP_SSL_CERT__#${APP_SSL_CERT}#g" \
  -e "s#__APP_SSL_KEY__#${APP_SSL_KEY}#g" \
  /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf

nginx -t

exec nginx -g "daemon off;"
