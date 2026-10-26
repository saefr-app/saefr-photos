#!/usr/bin/env bash
set -Eeuo pipefail

# This script may format only its own fresh image files on a GitHub-hosted VM.
if [[ "${GITHUB_ACTIONS:-}" != true ||
      "${EXPECTED_RUNNER_ENVIRONMENT:-}" != github-hosted ||
      "${EXPECTED_RUNNER_OS:-}" != Linux ||
      "${RUNNER_TEMP:-}" != /* ]]; then
  echo 'Disposable GitHub-hosted Linux VM required' >&2
  exit 2
fi

scratch="$(mktemp -d "${RUNNER_TEMP}/saefr-m12c-ext4.XXXXXXXX")"
first="${scratch}/first.img"
second="${scratch}/second.img"
first_mount="${scratch}/first"
second_mount="${scratch}/second"
cleanup() {
  local status=$?
  for mounted in "${second_mount}" "${first_mount}"; do
    if mountpoint -q -- "${mounted}"; then
      sudo umount -- "${mounted}" || status=1
    fi
  done
  if ! mountpoint -q -- "${second_mount}" &&
     ! mountpoint -q -- "${first_mount}"; then
    rm -rf -- "${scratch}"
    echo 'Disposable ext4 mounts and image files removed'
  else
    echo 'Disposable test mount remains attached; manual runner cleanup required' >&2
    status=1
  fi
  exit "${status}"
}
trap cleanup EXIT

mkdir -- "${first_mount}" "${second_mount}"
for image in "${first}" "${second}"; do
  # Refuse any existing path, symlink or block device. mkfs sees only a file
  # created exclusively in the fresh runner scratch directory.
  [[ ! -e "${image}" && ! -L "${image}" ]] || exit 2
  (set -C; : > "${image}")
  [[ -f "${image}" && ! -L "${image}" ]] || exit 2
  truncate -s 256M -- "${image}"
  [[ "$(stat -c %s -- "${image}")" == 268435456 ]] || exit 2
  mkfs.ext4 -F -q -- "${image}"
done

sudo mount -o loop,nodev,nosuid,noexec -- "${first}" "${first_mount}"
sudo mount -o loop,nodev,nosuid,noexec -- "${second}" "${second_mount}"
sudo chown "$(id -u):$(id -g)" "${first_mount}" "${second_mount}"
mkdir -- "${first_mount}/originals" "${first_mount}/thumbnails" "${second_mount}/originals"
chmod 755 "${scratch}" "${first_mount}" "${second_mount}" \
  "${first_mount}/originals" "${first_mount}/thumbnails" "${second_mount}/originals"

echo "Runner image: ${ImageOS:-unknown} ${ImageVersion:-unknown}"
echo "Kernel: $(uname -srvm)"
echo "Filesystem tools: $(mkfs.ext4 -V 2>&1 | head -1)"
findmnt -n -o FSTYPE,OPTIONS --target "${first_mount}"
findmnt -n -o FSTYPE,OPTIONS --target "${second_mount}"
[[ "$(stat -f -c %T -- "${first_mount}")" == ext2/ext3 ]] || {
  # GNU stat reports ext2/ext3 for ext4 on some coreutils versions.
  [[ "$(findmnt -n -o FSTYPE --target "${first_mount}")" == ext4 ]] || exit 2
}
[[ "$(findmnt -n -o FSTYPE --target "${second_mount}")" == ext4 ]] || exit 2
[[ "$(findmnt -n -o FSTYPE --target /dev/shm)" == tmpfs ]] || exit 2

SAEFR_NATIVE_FIRST="${first_mount}" SAEFR_NATIVE_SECOND="${second_mount}" \
  SAEFR_NATIVE_UNSUPPORTED=/dev/shm \
  node test/native-ext4-certification.mjs

# The intended runtime container must work without root or capabilities.
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --user "$(id -u):$(id -g)" \
  --pids-limit 64 --memory 128m \
  --mount "type=bind,source=${first_mount},target=/test,readonly" \
  --mount "type=bind,source=${PWD}/dist/native/storage-identity-observer,target=/observer,readonly" \
  node:24-bookworm sh -c 'exec 3</test/originals; exec /observer --identity'

sudo umount "${second_mount}"
SAEFR_NATIVE_MISSING="${second_mount}/originals" \
  node test/native-ext4-certification.mjs --missing
