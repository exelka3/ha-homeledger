ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.20
FROM ${BUILD_FROM}

# The app uses only the Python standard library.
RUN apk add --no-cache python3

# Supervisor passes the add-on version; shown in Settings and printed at startup.
ARG BUILD_VERSION
ENV HOMELEDGER_VERSION=${BUILD_VERSION}

COPY app/ /app/
COPY config.yaml /app/addon_config.yaml
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
