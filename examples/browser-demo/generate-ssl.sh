#!/bin/bash
# Locally-trusted HTTPS certs for the browser demo (same approach as flyte2-ui).
# Requires mkcert: https://github.com/FiloSottile/mkcert

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
CERT_DIR="${DIR}/certificate"
ROOT="$(cd "${DIR}/../.." && pwd)"

if [[ -f "${ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT}/.env"
  set +a
fi

DEV_HOST="${FLYTE_DEMO_HOST:-}"
ADMIN_HOST="${FLYTE_ADMIN_HOST:-}"
PORT="${FLYTE_DEMO_PORT:-8080}"

if [[ -z "${DEV_HOST}" || -z "${ADMIN_HOST}" ]]; then
  echo "Set FLYTE_DEMO_HOST and FLYTE_ADMIN_HOST in .env (see .env.example)."
  exit 1
fi

if ! command -v mkcert &>/dev/null; then
  echo "mkcert not found. Install it:"
  echo "  brew install mkcert && mkcert -install"
  exit 1
fi

mkdir -p "${CERT_DIR}"

PORT_FILE="${CERT_DIR}/.port"
if [[ -f "${CERT_DIR}/server.crt" && -f "${CERT_DIR}/server.key" && -f "${PORT_FILE}" && "$(cat "${PORT_FILE}")" == "${PORT}" ]]; then
  echo "SSL certs already exist in ${CERT_DIR} (port ${PORT})"
  exit 0
fi

if [[ -f "${CERT_DIR}/server.crt" ]]; then
  echo "Regenerating certs for port ${PORT} …"
  rm -f "${CERT_DIR}/server.crt" "${CERT_DIR}/server.key"
fi

echo "Generating trusted dev certs for ${DEV_HOST}:${PORT} …"
mkcert -install
mkcert \
  -cert-file "${CERT_DIR}/server.crt" \
  -key-file "${CERT_DIR}/server.key" \
  "${DEV_HOST}" \
  "https://${DEV_HOST}:${PORT}" \
  "*.${DEV_HOST}" \
  "${ADMIN_HOST}"

echo "Done. Certs written to ${CERT_DIR}"
echo "${PORT}" > "${PORT_FILE}"
