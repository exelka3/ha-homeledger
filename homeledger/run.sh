#!/usr/bin/with-contenv bashio
# shellcheck shell=bash

bashio::log.info "Starting Homeledger..."

export DATA_DIR=/data
export PORT=8099
# Only the Supervisor's Ingress proxy may reach the app.
export ALLOWED_CLIENTS=172.30.32.2

exec python3 -u /app/server.py
